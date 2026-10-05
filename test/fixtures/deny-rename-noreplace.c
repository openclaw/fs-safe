// Linux integration harness: only renameat2(RENAME_NOREPLACE) is rejected.
#include <errno.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 3 || (strcmp(argv[1], "EINVAL") && strcmp(argv[1], "ENOSYS"))) return 2;
    unsigned error = !strcmp(argv[1], "EINVAL") ? EINVAL : ENOSYS;
    unsigned flags = offsetof(struct seccomp_data, args) + 4 * 8;
#if __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
    flags += 4;
#endif
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_renameat2, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, flags),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 1, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | error),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog filter = { sizeof(instructions) / sizeof(instructions[0]), instructions };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &filter)) {
        perror("install renameat2 seccomp filter");
        return 1;
    }
    execvp(argv[2], argv + 2);
    perror("exec");
    return 1;
}
