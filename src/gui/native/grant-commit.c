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
static int revoke_record(const character *path) {
  HANDLE record = CreateFileW(path, GENERIC_WRITE | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_ALWAYS, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  BY_HANDLE_FILE_INFORMATION info;
  if (record == INVALID_HANDLE_VALUE) return 0;
  int ok = GetFileInformationByHandle(record, &info) && info.nNumberOfLinks == 1
      && !(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) && SetEndOfFile(record);
  CloseHandle(record);
  return ok;
}
#define publish(temp, dest) MoveFileExW(temp, dest, MOVEFILE_REPLACE_EXISTING)
/* Also take an existing per-record lock used by earlier desktop builds. */
static int lock_record(const character *directory, const character *path, int granting) {
  HANDLE dir = CreateFileW(directory, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  BY_HANDLE_FILE_INFORMATION info;
  if (dir == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(dir, &info)) return 0;
  wchar_t name[100];
  swprintf(name, 100, L"Global\\YaFolderConsent-%08lx-%08lx-%08lx", info.dwVolumeSerialNumber,
      info.nFileIndexHigh, info.nFileIndexLow);
  HANDLE mutex = CreateMutexW(NULL, FALSE, name);
  if (!mutex) return 0;
  DWORD wait = WaitForSingleObject(mutex, INFINITE);
  if (wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED) return 0;
  OVERLAPPED offset = {0};
  HANDLE lock = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
      NULL, granting ? OPEN_ALWAYS : OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (lock == INVALID_HANDLE_VALUE && !granting && GetLastError() == ERROR_FILE_NOT_FOUND) return 1;
  return lock != INVALID_HANDLE_VALUE && LockFileEx(lock, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &offset);
}
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#define ENTRY main
typedef char character;
#define open_record(path) fopen(path, "rb")
static int revoke_record(const character *path) {
  int record = open(path, O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0600);
  struct stat info;
  if (record < 0) return 0;
  int ok = fstat(record, &info) == 0 && S_ISREG(info.st_mode) && info.st_nlink == 1 && ftruncate(record, 0) == 0;
  close(record);
  return ok;
}
#define publish(temp, dest) (rename(temp, dest) == 0)
static int lock_record(const character *directory, const character *path, int granting) {
  int dir = open(directory, O_RDONLY | O_DIRECTORY);
  if (dir < 0 || flock(dir, LOCK_EX) != 0) return 0;
  int lock = open(path, O_RDWR | (granting ? O_CREAT : 0), 0600);
  if (lock < 0 && !granting && errno == ENOENT) return 1;
  return lock >= 0 && flock(lock, LOCK_EX) == 0;
}
#endif

int ENTRY(int argc, character **argv) {
  if (argc != 6 || !lock_record(argv[5], argv[4], argv[1][0] != 'r')) return 1;
  int mode = argv[1][0]; /* m: missing, c: compare stdin, r: revoke */
  if (mode == 'r') {
    /* The existing record and lock were allocated on grant. Truncation
     * invalidates the permission without allocating a replacement inode. */
    return revoke_record(argv[2]) ? 0 : 1;
  }
  {
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
