"""Fresh no-tools Responses call using Hermes' existing native auth router.
No AIAgent/session/memory/skill/tool executor is instantiated. No config is written.
"""
import contextlib
import inspect
import json
import os
from pathlib import Path
import sys

PHASE = "startup"


def field(value, key, default=None):
    return value.get(key, default) if isinstance(value, dict) else getattr(value, key, default)


def load_provider_resolver():
    from agent.auxiliary_client import resolve_provider_client

    if "raw_codex" not in inspect.signature(resolve_provider_client).parameters:
        raise RuntimeError("unsupported runtime")
    return resolve_provider_client


def parse_request():
    global PHASE
    PHASE = "request"
    request = json.loads(sys.stdin.read(2_000_001))
    expected_fields = {
        "provider",
        "model",
        "system",
        "payload",
        "timeoutMs",
        "maxTokens",
        "maxOutputBytes",
    }
    if set(request) != expected_fields:
        raise ValueError("request fields")
    if request["provider"] != "openai-codex":
        raise ValueError("unsupported provider")
    return request


def resolve_client(request, resolve_provider_client):
    global PHASE
    PHASE = "auth"
    client, model = resolve_provider_client(
        request["provider"],
        model=request["model"],
        raw_codex=True,
    )
    if client is None or model != request["model"]:
        raise RuntimeError("unavailable model/auth")
    return client, model


def create_response_stream(client, model, request):
    bounded = client.with_options(
        max_retries=0,
        timeout=request["timeoutMs"] / 1000,
    )
    return bounded.responses.create(
        model=model,
        instructions=request["system"],
        input=[{
            "role": "user",
            "content": json.dumps(request["payload"], ensure_ascii=False),
        }],
        tools=[],
        store=False,
        stream=True,
        reasoning={"effort": "medium"},
    )


def read_completed_response(stream, request):
    pieces = []
    completed = False
    usage = None
    response_model = None
    seen = 0

    for event in stream:
        seen += len(event.model_dump_json().encode())
        if seen > request["maxOutputBytes"] * 8:
            raise ValueError("stream byte limit")

        kind = field(event, "type")
        if completed:
            raise ValueError("events after terminal")
        if kind in ("error", "response.failed", "response.incomplete"):
            raise ValueError("non-completed response")

        if kind == "response.output_item.done":
            read_output_item(field(event, "item"), pieces)
        if kind == "response.completed":
            usage, response_model = validate_terminal_response(field(event, "response"))
            completed = True

    return pieces, completed, usage, response_model


def read_output_item(item, pieces):
    if field(item, "type") == "message":
        if field(item, "status") != "completed":
            raise ValueError("incomplete message")
        for part in field(item, "content", []):
            if field(part, "type") != "output_text":
                raise ValueError("refusal or non-text output")
            pieces.append(field(part, "text", ""))
    elif field(item, "type") != "reasoning":
        raise ValueError("unexpected tool/non-text output")


def validate_terminal_response(response):
    if field(response, "status") != "completed" or field(response, "error"):
        raise ValueError("invalid terminal status")
    return field(response, "usage"), field(response, "model")


def validate_completion(pieces, completed, request):
    text = "".join(pieces)
    if not completed or not text or len(text.encode()) > request["maxOutputBytes"]:
        raise ValueError("missing/oversized completion")
    return text


def build_result(text, usage, response_model, model):
    return {
        "protocol": 1,
        "text": text,
        "model": response_model or model,
        "modelIdentity": "response" if response_model else "requested",
        "stopReason": "stop",
        "usage": usage.model_dump() if usage else None,
    }


def invoke_request(request, resolve_provider_client):
    global PHASE
    client, model = resolve_client(request, resolve_provider_client)
    try:
        PHASE = "inference"
        # Native Codex does not support max_output_tokens. The outer process
        # enforces time/output limits; the stream is also byte-counted here.
        stream = create_response_stream(client, model, request)
        try:
            pieces, completed, usage, response_model = read_completed_response(stream, request)
        finally:
            stream.close()

        PHASE = "validation"
        text = validate_completion(pieces, completed, request)
        return build_result(text, usage, response_model, model)
    finally:
        client.close()


def run_in_runtime(check_only):
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        resolve_provider_client = load_provider_resolver()
        if check_only:
            return {"protocol": 1, "available": True, "adapter": "hermes-native-v1"}
        request = parse_request()
        return invoke_request(request, resolve_provider_client)


def main():
    root = Path(sys.argv[1]).resolve(strict=True)
    sys.path.insert(0, str(root))
    check_only = len(sys.argv) == 3 and sys.argv[2] == "--check"
    result = run_in_runtime(check_only)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Stage and exception class only, never provider error bodies or credentials.
        print(json.dumps({"protocol": 1, "error": "hermes_native_failure", "phase": PHASE,
                          "category": type(exc).__name__}))
        sys.exit(1)
