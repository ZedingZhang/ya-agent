/* The worker starts this helper in the verified grant root. Each argv element
 * is one path component. Hold both parent directories and the source while
 * waiting for approval; a closed input pipe means the worker cancelled. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#include <winternl.h>
#include <wchar.h>

typedef HANDLE object;
typedef wchar_t character;
#define INVALID_OBJECT INVALID_HANDLE_VALUE
#define close_object CloseHandle
#define parse_count(s) wcstol((s), NULL, 10)

/* winternl.h exposes NtOpenFile, but omits this companion API and its
 * FileRenameInformation selector. The documented NT form accepts a target
 * directory handle and a single relative name. */
NTSYSAPI NTSTATUS NTAPI NtSetInformationFile(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);

static int valid_component(const wchar_t *name) {
  return *name && wcscmp(name, L".") && wcscmp(name, L"..") && !wcspbrk(name, L"/\\:");
}

static object open_root(void) {
  return CreateFileW(L".", FILE_TRAVERSE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
      NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
}

/* Open exactly one entry relative to its parent. Opening the reparse point
 * itself lets us reject it without traversing a junction or symbolic link. */
static object open_entry(object parent, const wchar_t *name, int directory) {
  UNICODE_STRING component;
  RtlInitUnicodeString(&component, name);
  OBJECT_ATTRIBUTES attrs;
  InitializeObjectAttributes(&attrs, &component, OBJ_CASE_INSENSITIVE, parent, NULL);
  IO_STATUS_BLOCK status;
  HANDLE result;
  ACCESS_MASK access = FILE_READ_ATTRIBUTES | SYNCHRONIZE | (directory ? FILE_TRAVERSE : DELETE);
  if (!NT_SUCCESS(NtOpenFile(&result, access, &attrs, &status, FILE_SHARE_READ | FILE_SHARE_WRITE,
        FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | (directory ? FILE_DIRECTORY_FILE : 0)))) return INVALID_OBJECT;
  BY_HANDLE_FILE_INFORMATION info;
  if (!GetFileInformationByHandle(result, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    CloseHandle(result);
    return INVALID_OBJECT;
  }
  return result;
}

static int same_directory(object left, object right) {
  BY_HANDLE_FILE_INFORMATION a, b;
  return GetFileInformationByHandle(left, &a) && GetFileInformationByHandle(right, &b)
      && (a.nFileIndexHigh || a.nFileIndexLow) && a.dwVolumeSerialNumber == b.dwVolumeSerialNumber
      && a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow;
}

static int move_entry(object source, object from, const wchar_t *old_name, object to, const wchar_t *new_name) {
  (void)from; (void)old_name;
  DWORD bytes = (DWORD)(wcslen(new_name) * sizeof(wchar_t));
  DWORD size = sizeof(FILE_RENAME_INFO) + bytes;
  FILE_RENAME_INFO *rename = calloc(1, size);
  if (!rename) return 0;
  rename->RootDirectory = to;
  rename->FileNameLength = bytes;
  memcpy(rename->FileName, new_name, bytes);
  IO_STATUS_BLOCK io;
  NTSTATUS status = NtSetInformationFile(source, &io, rename, size, (FILE_INFORMATION_CLASS)10);
  int moved = NT_SUCCESS(status);
  if (!moved) fprintf(stderr, "Move failed (Windows error %lu).", RtlNtStatusToDosError(status));
  free(rename);
  return moved;
}

#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __linux__
#include <linux/fs.h>
#endif

typedef int object;
typedef char character;
#define INVALID_OBJECT (-1)
#define close_object close
#define parse_count(s) strtol((s), NULL, 10)

static int valid_component(const char *name) {
  return *name && strcmp(name, ".") && strcmp(name, "..") && !strchr(name, '/');
}
static object open_root(void) {
  return open(".", O_RDONLY | O_DIRECTORY);
}

static object open_entry(object parent, const char *name, int directory) {
  int flags = O_RDONLY | O_DIRECTORY;
  if (!directory) {
#ifdef __linux__
    flags = O_PATH;
#elif defined(__APPLE__)
    flags = O_EVTONLY | O_NONBLOCK;
#else
    flags = O_RDONLY | O_NONBLOCK;
#endif
  }
  int fd = openat(parent, name, flags | O_NOFOLLOW);
  struct stat st;
  if (fd >= 0 && (fstat(fd, &st) || !(S_ISDIR(st.st_mode) || S_ISREG(st.st_mode)))) {
    close(fd);
    return INVALID_OBJECT;
  }
  return fd;
}

static int same_entry(const struct stat *a, const struct stat *b) {
  return a->st_ino && a->st_ino == b->st_ino && a->st_dev == b->st_dev;
}
static int same_directory(object left, object right) {
  struct stat a, b;
  return !fstat(left, &a) && !fstat(right, &b) && same_entry(&a, &b);
}
static int move_entry(object source, object from, const char *old_name, object to, const char *new_name) {
  struct stat held, current;
  if (fstat(source, &held) || fstatat(from, old_name, &current, AT_SYMLINK_NOFOLLOW) || !same_entry(&held, &current)) {
    fputs("Move source changed during approval.", stderr);
    return 0;
  }
#ifdef __APPLE__
  if (!renameatx_np(from, old_name, to, new_name, RENAME_EXCL)) return 1;
#elif defined(__linux__)
  if (!renameat2(from, old_name, to, new_name, RENAME_NOREPLACE)) return 1;
#else
  fputs("Exclusive rename is unavailable.", stderr);
  return 0;
#endif
  perror("Move failed");
  return 0;
}
#endif

static object open_parent(character **path, int components) {
  object dir = open_root();
  for (int i = 0; i < components - 1 && dir != INVALID_OBJECT; ++i) {
    object next = open_entry(dir, path[i], 1);
    close_object(dir);
    dir = next;
  }
  return dir;
}

static int still_attached(object parent, character **path, int count) {
  object current = open_parent(path, count);
  if (current == INVALID_OBJECT) return 0;
  int matches = same_directory(parent, current);
  close_object(current);
  return matches;
}

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
#else
int main(int argc, char **argv) {
#endif
  if (argc < 4) return 1;
  long count = parse_count(argv[1]);
  if (count < 1 || count > argc - 3) return 1;
  for (int i = 2; i < argc; ++i) if (!valid_component(argv[i])) return 1;
  int from_count = (int)count, to_count = argc - 2 - from_count;
  character **from = argv + 2, **to = from + from_count;
  object from_dir = open_parent(from, from_count), to_dir = open_parent(to, to_count);
  if (from_dir == INVALID_OBJECT || to_dir == INVALID_OBJECT) {
    fputs("Move parent directory is unavailable or has changed.", stderr);
    return 1;
  }
  object source = open_entry(from_dir, from[from_count - 1], 0);
  if (source == INVALID_OBJECT) {
    fputs("Move source is unavailable or has changed.", stderr);
    return 1;
  }
  putchar('R');
  fflush(stdout);
  if (getchar() != 'Y') return 2;
  if (!still_attached(from_dir, from, from_count) || !still_attached(to_dir, to, to_count)) {
    fputs("Move parent directory changed during approval.", stderr);
    return 1;
  }
  return move_entry(source, from_dir, from[from_count - 1], to_dir, to[to_count - 1]) ? 0 : 1;
}
