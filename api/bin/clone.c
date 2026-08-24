// clone — thin wrapper around the platform's copy-on-write clone primitive.
// Usage: clone <src> <dst>
#include <stdio.h>
#include <errno.h>
#include <string.h>
#if defined(__APPLE__)
#include <sys/clonefile.h>
#elif defined(__linux__)
#include <unistd.h>
#else
#error "The isopod clone helper supports only macOS and Linux"
#endif

int main(int argc, char** argv) {
  if (argc != 3) { fprintf(stderr, "usage: %s <src> <dst>\n", argv[0]); return 2; }
#if defined(__APPLE__)
  if (clonefile(argv[1], argv[2], 0) != 0) {
    fprintf(stderr, "clonefile: %s\n", strerror(errno));
    return 1;
  }
  return 0;
#elif defined(__linux__)
  // GNU cp owns the recursive filesystem semantics; --reflink=always makes a
  // failed copy-on-write clone visible instead of silently doing a full copy.
  execlp("cp", "cp", "-a", "--reflink=always", "--", argv[1], argv[2], (char*)NULL);
  fprintf(stderr, "cp --reflink=always: %s\n", strerror(errno));
  return 1;
#endif
}
