// Linux integration harness: cc deny-openat2.c -o /tmp/deny-openat2
// /tmp/deny-openat2 ENOSYS|EPERM command [args...]
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
    if (argc < 3 || (strcmp(argv[1], "ENOSYS") && strcmp(argv[1], "EPERM"))) return 2;
    unsigned error = !strcmp(argv[1], "ENOSYS") ? ENOSYS : EPERM;
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_openat2, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | error),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog filter = { sizeof(instructions) / sizeof(instructions[0]), instructions };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &filter)) {
        perror("install openat2 seccomp filter");
        return 1;
    }
    execvp(argv[2], argv + 2);
    perror("exec");
    return 1;
}
