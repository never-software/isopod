"""
wm_stream — SSE streaming for Windmill raw_stream HTTP triggers.

Writes Server-Sent Events directly to the HTTP response stream via
a file descriptor passed by the Windmill runtime.

Environment:
    WM_STREAM_FD  — file descriptor number opened by the raw_stream trigger.
                    Inherited by flow-step subprocesses when the Windmill
                    backend is configured to propagate it (see below).

Flow-step support:
    Windmill executes each flow step in a worker subprocess.  For wm_stream
    to work inside a flow step the raw_stream FD must survive across the
    fork/exec boundary.  Two things are required on the backend side:

    1.  The FD must NOT be opened with O_CLOEXEC (close-on-exec).
        By default, os.pipe() in Python and most Rust helpers set
        close-on-exec.  The Windmill worker that creates the pipe for
        raw_stream must clear the flag before spawning the step process:

            // Rust (nix crate)
            use nix::fcntl::{fcntl, FcntlArg, FdFlag};
            fcntl(raw_fd, FcntlArg::F_SETFD(FdFlag::empty())).unwrap();

    2.  The WM_STREAM_FD environment variable must be forwarded into the
        step subprocess environment so this module can discover it.

    If both conditions are met, wm_stream.write() works identically in
    top-level scripts and in flow steps — no code changes on the script side.
"""

from __future__ import annotations

import os
import sys
from typing import Optional

__all__ = ["write", "close"]

_stream_file: Optional["_StreamFile"] = None


class _StreamFile:
    """Thin wrapper around the raw FD so we can flush per-write."""

    def __init__(self, fd: int) -> None:
        # Duplicate so the caller can't accidentally close our copy.
        self._fd = fd
        # Line-buffered file object for convenience; we still flush explicitly.
        self._f = os.fdopen(os.dup(fd), "w", buffering=1)

    def write(self, data: str) -> None:
        self._f.write(data)
        self._f.flush()

    def close(self) -> None:
        try:
            self._f.close()
        except OSError:
            pass


def _get_stream() -> _StreamFile:
    global _stream_file
    if _stream_file is not None:
        return _stream_file

    fd_str = os.environ.get("WM_STREAM_FD")
    if fd_str is None:
        raise RuntimeError(
            "WM_STREAM_FD environment variable is not set. "
            "wm_stream.write() can only be called from a Windmill "
            "raw_stream HTTP trigger context."
        )

    try:
        fd = int(fd_str)
    except ValueError:
        raise RuntimeError(f"WM_STREAM_FD is not a valid integer: {fd_str!r}")

    _stream_file = _StreamFile(fd)
    return _stream_file


def write(data: str) -> None:
    """Write a string to the raw_stream response.

    Typical SSE usage::

        wm_stream.write("data: {\"hello\": \"world\"}\\n\\n")
        wm_stream.write("data: [DONE]\\n\\n")
    """
    _get_stream().write(data)


def close() -> None:
    """Explicitly close the stream (optional — also closed on process exit)."""
    global _stream_file
    if _stream_file is not None:
        _stream_file.close()
        _stream_file = None
