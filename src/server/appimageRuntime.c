#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/*
 * Continuum Self-Contained x86_64 Linux AppImage Runtime (Zero-FUSE)
 *
 * Binary layout:
 *   [ Static ELF x86_64 Runtime Binary ]
 *   [ Embedded Continuum.AppDir (.tar.gz) ]
 *   [ 32-byte Footer: 16-byte magic + uint64_le offset + uint64_le size ]
 *
 * Works on any x86_64 Linux distro (Zorin OS 16/17, Ubuntu 18-24, Debian, Fedora, Arch)
 * without requiring libfuse2 or FUSE kernel mounts.
 */

static const char FOOTER_MAGIC[16] = "CONT_APPIMG_V1\0";
static volatile pid_t g_child_pid = -1;

static void forward_signal(int sig) {
  if (g_child_pid > 0) {
    kill(g_child_pid, sig);
  }
}

static uint64_t read_u64_le(const unsigned char *buf) {
  uint64_t v = 0;
  for (int i = 0; i < 8; i++) {
    v |= ((uint64_t)buf[i]) << (8 * i);
  }
  return v;
}

static int read_all_at(int fd, off_t offset, unsigned char *buf, size_t len) {
  size_t done = 0;
  while (done < len) {
    ssize_t n = pread(fd, buf + done, len - done, offset + (off_t)done);
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (n == 0) return -1;
    done += (size_t)n;
  }
  return 0;
}

static int write_all(int fd, const unsigned char *buf, size_t len) {
  size_t done = 0;
  while (done < len) {
    ssize_t n = write(fd, buf + done, len - done);
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    done += (size_t)n;
  }
  return 0;
}

static int extract_payload_to(int self_fd, uint64_t offset, uint64_t size, const char *dest_dir) {
  int pipefd[2];
  if (pipe(pipefd) != 0) {
    perror("continuum-appimage: pipe");
    return -1;
  }

  pid_t pid = fork();
  if (pid < 0) {
    perror("continuum-appimage: fork(tar)");
    close(pipefd[0]);
    close(pipefd[1]);
    return -1;
  }

  if (pid == 0) {
    close(pipefd[1]);
    if (dup2(pipefd[0], STDIN_FILENO) < 0) _exit(126);
    close(pipefd[0]);
    char *tar_argv[] = {"tar", "-xzf", "-", "-C", (char *)dest_dir, NULL};
    execvp("tar", tar_argv);
    _exit(127);
  }

  close(pipefd[0]);

  unsigned char chunk[65536];
  uint64_t remaining = size;
  off_t cur_off = (off_t)offset;
  int write_failed = 0;

  while (remaining > 0) {
    size_t to_read = remaining > sizeof(chunk) ? sizeof(chunk) : (size_t)remaining;
    if (read_all_at(self_fd, cur_off, chunk, to_read) != 0) {
      write_failed = 1;
      break;
    }
    if (write_all(pipefd[1], chunk, to_read) != 0) {
      write_failed = 1;
      break;
    }
    cur_off += (off_t)to_read;
    remaining -= to_read;
  }

  close(pipefd[1]);

  int status = 0;
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}

  if (write_failed || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    fprintf(stderr, "continuum-appimage: falha ao extrair AppDir em %s\n", dest_dir);
    return -1;
  }
  return 0;
}

static void cleanup_dir(const char *dir_path) {
  pid_t pid = fork();
  if (pid == 0) {
    char *rm_argv[] = {"rm", "-rf", "--", (char *)dir_path, NULL};
    execvp("rm", rm_argv);
    _exit(0);
  } else if (pid > 0) {
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
  }
}

int main(int argc, char *argv[]) {
  int extract_only = 0;
  int strip_extract_and_run = 0;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--appimage-help") == 0) {
      printf("Continuum Linux Native GTK 3 AppImage (v2.0.0 — Zero-FUSE)\n");
      printf("Uso:\n");
      printf("  %s                         Abre o aplicativo nativo GTK 3\n", argv[0]);
      printf("  %s --bridge-only           Executa apenas a ponte nativa em segundo plano\n", argv[0]);
      printf("  %s --appimage-extract      Extrai o AppDir para ./squashfs-root\n", argv[0]);
      printf("  %s --appimage-version      Exibe a versao do AppImage\n", argv[0]);
      return 0;
    }
    if (strcmp(argv[i], "--appimage-version") == 0) {
      printf("Continuum Linux Native AppImage 2.0.0\n");
      return 0;
    }
    if (strcmp(argv[i], "--appimage-extract") == 0) {
      extract_only = 1;
    } else if (strcmp(argv[i], "--appimage-extract-and-run") == 0) {
      strip_extract_and_run = 1;
    }
  }

  char self_path[PATH_MAX];
  ssize_t path_len = readlink("/proc/self/exe", self_path, sizeof(self_path) - 1);
  if (path_len < 0) {
    perror("continuum-appimage: readlink(/proc/self/exe)");
    return 1;
  }
  self_path[path_len] = '\0';

  int self_fd = open(self_path, O_RDONLY);
  if (self_fd < 0) {
    perror("continuum-appimage: open");
    return 1;
  }

  struct stat st;
  if (fstat(self_fd, &st) != 0 || st.st_size < 64) {
    fprintf(stderr, "continuum-appimage: arquivo AppImage invalido.\n");
    close(self_fd);
    return 1;
  }

  unsigned char footer[32];
  if (read_all_at(self_fd, st.st_size - 32, footer, 32) != 0) {
    fprintf(stderr, "continuum-appimage: erro ao ler cabecalho final.\n");
    close(self_fd);
    return 1;
  }

  if (memcmp(footer, FOOTER_MAGIC, 16) != 0) {
    fprintf(stderr, "continuum-appimage: assinatura de payload ausente.\n");
    close(self_fd);
    return 1;
  }

  uint64_t payload_offset = read_u64_le(footer + 16);
  uint64_t payload_size = read_u64_le(footer + 24);
  if (payload_offset >= (uint64_t)st.st_size ||
      payload_size == 0 ||
      payload_offset + payload_size > (uint64_t)(st.st_size - 32)) {
    fprintf(stderr, "continuum-appimage: limites de payload corrompidos.\n");
    close(self_fd);
    return 1;
  }

  if (extract_only) {
    if (mkdir("squashfs-root", 0755) != 0 && errno != EEXIST) {
      perror("continuum-appimage: mkdir(squashfs-root)");
      close(self_fd);
      return 1;
    }
    int rc = extract_payload_to(self_fd, payload_offset, payload_size, "squashfs-root");
    close(self_fd);
    if (rc == 0) {
      printf("squashfs-root\n");
      return 0;
    }
    return 1;
  }

  char mount_dir[] = "/tmp/.mount_Continuum_XXXXXX";
  if (mkdtemp(mount_dir) == NULL) {
    perror("continuum-appimage: mkdtemp");
    close(self_fd);
    return 1;
  }

  if (extract_payload_to(self_fd, payload_offset, payload_size, mount_dir) != 0) {
    close(self_fd);
    cleanup_dir(mount_dir);
    return 1;
  }
  close(self_fd);

  setenv("APPDIR", mount_dir, 1);
  setenv("APPIMAGE", self_path, 1);
  setenv("ARGV0", argv[0], 1);

  char apprun_path[PATH_MAX];
  snprintf(apprun_path, sizeof(apprun_path), "%s/AppRun", mount_dir);

  char **child_argv = calloc((size_t)argc + 1, sizeof(char *));
  if (!child_argv) {
    cleanup_dir(mount_dir);
    return 1;
  }
  int out_idx = 0;
  child_argv[out_idx++] = apprun_path;
  for (int i = 1; i < argc; i++) {
    if (strip_extract_and_run && strcmp(argv[i], "--appimage-extract-and-run") == 0) {
      continue;
    }
    child_argv[out_idx++] = argv[i];
  }
  child_argv[out_idx] = NULL;

  signal(SIGINT, forward_signal);
  signal(SIGTERM, forward_signal);

  pid_t child = fork();
  if (child < 0) {
    perror("continuum-appimage: fork(AppRun)");
    free(child_argv);
    cleanup_dir(mount_dir);
    return 1;
  }

  if (child == 0) {
    execv(apprun_path, child_argv);
    perror("continuum-appimage: execv(AppRun)");
    _exit(127);
  }

  g_child_pid = child;
  int status = 0;
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
  g_child_pid = -1;

  free(child_argv);
  cleanup_dir(mount_dir);

  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 0;
}
