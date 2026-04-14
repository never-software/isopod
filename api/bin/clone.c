// clone — thin wrapper around macOS clonefile() for fast COW copies on APFS.
// Usage: clone <src> <dst>
#include <sys/clonefile.h>
#include <stdio.h>
#include <errno.h>
#include <string.h>
int main(int argc, char** argv) {
  if (argc != 3) { fprintf(stderr, "usage: %s <src> <dst>\n", argv[0]); return 2; }
  if (clonefile(argv[1], argv[2], 0) != 0) {
    fprintf(stderr, "clonefile: %s\n", strerror(errno));
    return 1;
  }
  return 0;
}
