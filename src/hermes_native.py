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


def main():
    global PHASE
    root = Path(sys.argv[1]).resolve(strict=True)
    sys.path.insert(0, str(root))
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        from agent.auxiliary_client import resolve_provider_client
        if "raw_codex" not in inspect.signature(resolve_provider_client).parameters:
            raise RuntimeError("unsupported runtime")
        if len(sys.argv) == 3 and sys.argv[2] == "--check":
            result = {"protocol": 1, "available": True, "adapter": "hermes-native-v1"}
        else:
            PHASE = "request"
            request = json.loads(sys.stdin.read(2_000_001))
            if set(request) != {"provider", "model", "system", "payload", "timeoutMs", "maxTokens", "maxOutputBytes"}:
                raise ValueError("request fields")
            if request["provider"] != "openai-codex":
                raise ValueError("unsupported provider")
            PHASE = "auth"
            client, model = resolve_provider_client(request["provider"], model=request["model"], raw_codex=True)
            if client is None or model != request["model"]:
                raise RuntimeError("unavailable model/auth")
            try:
                PHASE = "inference"
                # Native Codex does not support max_output_tokens. The outer process
                # enforces time/output limits; the stream is also byte-counted here.
                bounded = client.with_options(max_retries=0, timeout=request["timeoutMs"] / 1000)
                stream = bounded.responses.create(
                    model=model, instructions=request["system"],
                    input=[{"role": "user", "content": json.dumps(request["payload"], ensure_ascii=False)}],
                    tools=[], store=False, stream=True, reasoning={"effort": "medium"},
                )
                pieces, completed, usage, response_model = [], False, None, None
                seen = 0
                try:
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
                            item = field(event, "item")
                            if field(item, "type") == "message":
                                if field(item, "status") != "completed":
                                    raise ValueError("incomplete message")
                                for part in field(item, "content", []):
                                    if field(part, "type") != "output_text":
                                        raise ValueError("refusal or non-text output")
                                    pieces.append(field(part, "text", ""))
                            elif field(item, "type") != "reasoning":
                                raise ValueError("unexpected tool/non-text output")
                        if kind == "response.completed":
                            final = field(event, "response")
                            if field(final, "status") != "completed" or field(final, "error"):
                                raise ValueError("invalid terminal status")
                            completed = True
                            usage = field(final, "usage")
                            response_model = field(final, "model")
                finally:
                    stream.close()
                PHASE = "validation"
                text = "".join(pieces)
                if not completed or not text or len(text.encode()) > request["maxOutputBytes"]:
                    raise ValueError("missing/oversized completion")
                # Preserve final model text, including malformed JSON, in the run
                # journal. The runner performs exact JSON + schema validation.
                result = {"protocol": 1, "text": text, "model": response_model or model,
                          "modelIdentity": "response" if response_model else "requested",
                          "stopReason": "stop", "usage": usage.model_dump() if usage else None}
            finally:
                client.close()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Stage and exception class only, never provider error bodies or credentials.
        print(json.dumps({"protocol": 1, "error": "hermes_native_failure", "phase": PHASE,
                          "category": type(exc).__name__}))
        sys.exit(1)
