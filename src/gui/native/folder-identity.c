/* Print an opaque, volume-scoped identifier, or fail if the filesystem cannot
 * provide one. Only the picker may create a Windows object ID. */
#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>

static void print_hex(const void *data, size_t size) {
  const unsigned char *bytes = data;
  for (size_t i = 0; i < size; ++i) printf("%02x", bytes[i]);
}

#ifdef _WIN32
#include <windows.h>
#include <winioctl.h>
#include <wchar.h>

int wmain(int argc, wchar_t **argv) {
  if (argc != 3) return 1;
  HANDLE dir = CreateFileW(argv[2], FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (dir == INVALID_HANDLE_VALUE) return 1;
  BY_HANDLE_FILE_INFORMATION info;
  FILE_OBJECTID_BUFFER id;
  DWORD size;
  DWORD op = wcscmp(argv[1], L"grant") == 0 ? FSCTL_CREATE_OR_GET_OBJECT_ID : FSCTL_GET_OBJECT_ID;
  int ok = GetFileInformationByHandle(dir, &info)
      && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
      && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
      && DeviceIoControl(dir, op, NULL, 0, &id, sizeof(id), &size, NULL)
      && size >= sizeof(id.ObjectId);
  CloseHandle(dir);
  if (!ok) return 1;
  printf("win-%08lx-", info.dwVolumeSerialNumber);
  print_hex(id.ObjectId, sizeof(id.ObjectId));
  return 0;
}
#else
#include <fcntl.h>
#include <stdint.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef __APPLE__
#include <sys/attr.h>
#include <uuid/uuid.h>

static int print_identity(int dir) {
  struct attrlist attrs = { .bitmapcount = ATTR_BIT_MAP_COUNT,
      .volattr = ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES | ATTR_VOL_UUID };
  struct { uint32_t length; vol_capabilities_attr_t caps; uuid_t uuid; } volume;
  struct stat info;
  if (fgetattrlist(dir, &attrs, &volume, sizeof(volume), 0) || fstat(dir, &info)
      || !info.st_ino || volume.length != sizeof(volume) || uuid_is_null(volume.uuid)) return 1;
  /* PATH_FROM_ID explicitly guarantees persistent, non-recycled object IDs. */
  if (!(volume.caps.valid[VOL_CAPABILITIES_FORMAT] &
        volume.caps.capabilities[VOL_CAPABILITIES_FORMAT] & VOL_CAP_FMT_PATH_FROM_ID)) return 1;
  printf("mac-");
  print_hex(volume.uuid, sizeof(volume.uuid));
  printf("-%llu", (unsigned long long)info.st_ino);
  return 0;
}
#elif defined(__linux__)
#include <stdlib.h>
#include <sys/vfs.h>

static int print_identity(int dir) {
  struct statfs volume;
  const unsigned char empty_fsid[sizeof(volume.f_fsid)] = {0};
  int mount_id;
  struct file_handle *handle = calloc(1, sizeof(*handle) + MAX_HANDLE_SZ);
  if (!handle) return 1;
  handle->handle_bytes = MAX_HANDLE_SZ;
  int ok = fstatfs(dir, &volume) == 0 && memcmp(&volume.f_fsid, empty_fsid, sizeof(empty_fsid)) != 0
      && name_to_handle_at(dir, ".", handle, &mount_id, 0) == 0
      && handle->handle_bytes > 0 && handle->handle_bytes <= MAX_HANDLE_SZ;
  if (ok) {
    printf("linux-");
    print_hex(&volume.f_fsid, sizeof(volume.f_fsid));
    printf("-%x-", (unsigned)handle->handle_type);
    print_hex(handle->f_handle, handle->handle_bytes);
  }
  free(handle);
  return ok ? 0 : 1;
}
#else
static int print_identity(int dir) { (void)dir; return 1; }
#endif

int main(int argc, char **argv) {
  if (argc != 3) return 1;
  int dir = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (dir < 0) return 1;
  int result = print_identity(dir);
  close(dir);
  return result;
}
#endif
