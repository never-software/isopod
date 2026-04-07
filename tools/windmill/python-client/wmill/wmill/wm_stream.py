"""
wm_stream — SSE streaming module for Windmill raw_stream HTTP triggers.

When a Windmill script or flow step runs behind a raw_stream HTTP trigger,
the runtime opens a pipe and passes its write-end as file descriptor 3
(or the FD number in the WM_STREAM_FD environment variable). Writing to
this FD sends bytes directly to the HTTP client in real time.

Usage:
    import wm_stream
    wm_stream.write("data: hello\\n\\n")

The module is installed in the worker global site-packages so it is
available to all scripts without explicit dependency declaration.
"""

import os
import sys

_fd: int | None = None
_file = None


def _get_stream_file():
    """Lazily open the stream FD on first write."""
    global _fd, _file
    if _file is not None:
        return _file

    fd_str = os.environ.get("WM_STREAM_FD", "3")
    try:
        _fd = int(fd_str)
    except ValueError:
        raise RuntimeError(
            f"WM_STREAM_FD={fd_str!r} is not a valid file descriptor"
        )

    try:
        _file = os.fdopen(_fd, "w", buffering=1)  # line-buffered
    except OSError as exc:
        raise RuntimeError(
            f"Could not open stream FD {_fd}. Is this running behind a "
            f"raw_stream HTTP trigger? (error: {exc})"
        )

    return _file


def write(data: str) -> None:
    """Write SSE data to the raw_stream pipe.

    The caller is responsible for SSE framing, e.g.:
        wm_stream.write("data: {}\n\n".format(json.dumps(payload)))
    """
    f = _get_stream_file()
    f.write(data)
    f.flush()
