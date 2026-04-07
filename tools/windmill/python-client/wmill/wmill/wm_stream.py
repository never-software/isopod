"""
wm_stream — SSE streaming helper for Windmill raw_stream HTTP triggers.

Writes SSE-formatted data to the file descriptor specified by the
WM_STREAM_FD environment variable. This FD is opened by the Windmill
worker when a raw_stream HTTP trigger invokes a script or flow step.

Usage:
    import wm_stream
    wm_stream.write("data: hello\n\n")
    wm_stream.close()
"""

import os

_fd = None
_file = None


def _ensure_open():
    global _fd, _file
    if _file is not None:
        return
    fd_str = os.environ.get("WM_STREAM_FD")
    if fd_str is None:
        raise RuntimeError(
            "WM_STREAM_FD not set — wm_stream.write() can only be called "
            "inside a Windmill raw_stream HTTP trigger context"
        )
    _fd = int(fd_str)
    _file = os.fdopen(_fd, "w", buffering=1)  # line-buffered


def write(data: str) -> None:
    """Write raw SSE data to the streaming response."""
    _ensure_open()
    _file.write(data)
    _file.flush()


def close() -> None:
    """Close the stream FD (optional — Windmill cleans up on exit)."""
    global _file
    if _file is not None:
        _file.close()
        _file = None
