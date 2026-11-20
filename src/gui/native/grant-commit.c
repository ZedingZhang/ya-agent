/* Serialize compare-and-replace of a bot's local permission record. The OS
 * releases the lock on exit, including when the caller times out or crashes. */
#include <errno.h>
#include <stdio.h>

#ifdef _WIN32
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <wchar.h>
#define ENTRY wmain
typedef wchar_t character;
#define open_record(path) _wfopen(path, L"rb")
#define publish(temp, dest) MoveFileExW(temp, dest, MOVEFILE_REPLACE_EXISTING)
static int lock_record(const character *path) {
  OVERLAPPED offset = {0};
  HANDLE lock = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
      NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  return lock != INVALID_HANDLE_VALUE && LockFileEx(lock, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &offset);
}
#else
#include <fcntl.h>
#include <sys/file.h>
#define ENTRY main
typedef char character;
#define open_record(path) fopen(path, "rb")
#define publish(temp, dest) (rename(temp, dest) == 0)
static int lock_record(const character *path) {
  int lock = open(path, O_CREAT | O_RDWR, 0600);
  return lock >= 0 && flock(lock, LOCK_EX) == 0;
}
#endif

int ENTRY(int argc, character **argv) {
  if (argc != 5 || !lock_record(argv[4])) return 1;
  int mode = argv[1][0]; /* m: missing, c: compare stdin, r: revoke */
  if (mode != 'r') {
    FILE *record = open_record(argv[2]);
    if (!record && errno != ENOENT) return 1;
    if (mode == 'm' && record) return 2;
    if (mode == 'c') {
      if (!record) return 2;
#ifdef _WIN32
      if (_setmode(_fileno(stdin), _O_BINARY) == -1) return 1;
#endif
      int byte;
      do {
        byte = fgetc(record);
        if (byte != fgetc(stdin)) return 2;
      } while (byte != EOF);
      if (ferror(record) || ferror(stdin)) return 1;
      fclose(record);
    } else if (mode != 'm') return 1;
  }
  return publish(argv[3], argv[2]) ? 0 : 1;
}
