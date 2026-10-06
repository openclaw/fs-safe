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
    if (argc < 3) return 2;
    unsigned error = EINVAL;
    unsigned extra_syscall = -1, extra_errno = EPERM;
    if (!strcmp(argv[1], "ENOSYS")) error = ENOSYS;
    else if (!strcmp(argv[1], "EINVAL-linkat")) extra_syscall = __NR_linkat;
    else if (!strcmp(argv[1], "EINVAL-unlinkat")) { extra_syscall = __NR_unlinkat; extra_errno = EACCES; }
    else if (strcmp(argv[1], "EINVAL")) return 2;
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
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, extra_syscall, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | extra_errno),
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
