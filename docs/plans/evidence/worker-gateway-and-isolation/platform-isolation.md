# Platform isolation for summoned workers

Date: **2026-09-29**. Research only: nothing here was built, deployed or run on
any platform, and no account was used.

**The question.** bun-jobs can summon compute to run a `BunQueueWorker`. The
targets are Cloud Run, Lambda, ECS/Fargate, Fly Machines, Railway, Render,
Azure Container Apps and plain VMs over SSH (see
[`../summon-compute/`](../summon-compute/README.md)). The user wants an
optional isolation layer, so that a malicious job can neither harm the summoned
compute nor read its secrets. Examples: a hardened container per job, or a
warm pool of job runners.

For each platform this file answers five questions:

1. What isolation does the platform already give, between tenants and between
   successive runs on one instance?
2. Can we nest? That covers Docker, namespaces, `--privileged`,
   `CAP_SYS_ADMIN`, user namespaces (bubblewrap) and `/dev/kvm`.
3. Can the platform itself launch our image hardened, once per summon?
4. What egress controls exist, and how is the metadata or credential endpoint
   exposed?
5. The verdict.

## Provenance legend

| Mark | Meaning |
|---|---|
| **[V]** | Read today, 2026-09-29, from a primary source: vendor docs, vendor blog, vendor repo or the project's own docs. The key names the entry in [Sources](#sources). |
| **[V-prior]** | Carried from an earlier evidence file in this repo and not re-read today. The file is named. |
| **[I]** | Inference from verified facts. The reasoning is given. It is a claim to test. |
| **[U]** | Unverified: no primary source found today, or only a secondary one. Nothing should rest on it. |

**Method.** Four passes gathered the facts: AWS plus Kubernetes/VM (the
author's), Google, Azure, and PaaS/edge (Fly, Railway, Render, Cloudflare).
Most pages were read through a summarising fetcher, so a quote can be a light
paraphrase. The AWS Lambda whitepaper was read as raw PDF text. Two surprising
claims were re-read independently while assembling, and both held:

- Cloud Run sandboxes block egress and the metadata server by default.
- Cloudflare Containers run Docker only rootless, with host networking.

## Summary table

Cells are short on purpose. The number in the first column is the note below
that carries the detail and the sources.

| Platform | Tenant isolation | Docker inside? | userns / bwrap? | /dev/kvm? | Per-task hardening knobs | Egress / metadata | Verdict |
|---|---|---|---|---|---|---|---|
| 1 Lambda (default) | Firecracker microVM [V] | No [I] | EPERM reported [U] | No [I] | Read-only FS, non-root user [V] | SG via VPC; keys in env vars [V] | Platform only; one env per job run |
| 2 Lambda MicroVMs | Firecracker, per MicroVM [V] | Plausible, untested [U] | Plausible [U] | Not documented [U] | One MicroVM per job; hooks [V] | Egress connectors [V] | Platform: MicroVM per job |
| 3 ECS on Fargate | VM boundary per task [V] | No: no privileged [V] | EPERM reported [U] | No: no devices [V] | RO rootfs, user, cap drop [V] | SG + NACL; creds 169.254.170.2 [V] | Platform: fresh task per job |
| 4 ECS on EC2 | Shared kernel per host [I] | Yes: privileged [V] | Yes if host allows [I] | 7i/8i nested virt [V] | Privileged, caps, AppArmor [V] | awsvpc SG; block IMDS [V] | Docker/gVisor/Kata on host |
| 5 EC2 VM (SSH) | Nitro VM [I] | Yes [I] | Yes [I] | 7i/8i or .metal [V] | Whatever we install [I] | SG; IMDSv2, hop limit 1 [V] | Docker, gVisor or Firecracker |
| 6 Cloud Run gen1 | gVisor + VMM [V] | No [V] | No [I] | No [I] | Contract fixed; no privileged [V] | Direct VPC egress; metadata [V] | Services only; prefer gen2 |
| 7 Cloud Run gen2 | microVM + VMM [V] | No: no privileged [V] | Unknown; needs probe [U] | No [I] | Cloud Run sandboxes (Preview) [V] | Sandbox: no egress, no metadata [V] | Platform sandbox per job |
| 8 GKE | Shared node kernel [I] | Standard: privileged [V] | Upstream GA in 1.36 [V] | Standard nested virt [V] | gVisor RuntimeClass, PSS [V] | FQDN policy; GKE metadata [V] | GKE Sandbox / Agent Sandbox |
| 9 Azure Container Apps | Env boundary; tech unnamed [U] | No: no privileged [V] | Not documented [U] | Not documented [U] | Dynamic sessions: Hyper-V [V] | Session egress off by default [V] | Dynamic session per job |
| 10 Azure Container Instances | "As isolated as a VM" [V] | No: no privileged [V] | Not documented [U] | Not documented [U] | Fresh group per job; confidential [V] | NSG + NAT; IMDS on Linux [V] | Platform: group per job |
| 11 AKS | Shared kernel; Kata option [V] | Kata guest only [V] | 1.33+ hostUsers [V] | Nested-virt sizes [V] | kata-vm-isolation RuntimeClass [V] | NetworkPolicy [V] | Pod Sandboxing (Kata) |
| 12 Kubernetes (generic) | Shared kernel [I] | Privileged or sysbox [V] | hostUsers GA 1.36 [V] | Node-dependent [I] | securityContext, PSS [V] | NetworkPolicy, L3/4 only [V] | RuntimeClass gVisor/Kata |
| 13 Fly Machines | Firecracker microVM each [V] | Yes: dockerd runs [V] | Plausible: root in VM [U] | No: nested virt refused [V] | Machine per job; net policy [V] | Port-only policy; OIDC socket [V] | Machine per job, or gVisor inside |
| 14a Railway services | Container; runtime unnamed [U] | No: staff say not possible [V] | Not documented [U] | No [I] | None documented [U] | No egress filter [V] | Use Railway Sandboxes |
| 14b Railway Sandboxes | "Isolated Linux VMs" [V] | Yes: dockerd included [V] | Not documented [U] | Not documented [U] | Sandbox per job; checkpoints [V] | NAT egress; no deny mode [V] | Sandbox per job; egress open |
| 15 Render | Containers on Kubernetes [V] | No [I] | Not documented [U] | No [I] | None documented [U] | No egress filter; shared IPs [V] | Not for untrusted code [V] |
| 16 Cloudflare Containers | VM per instance [V] | Rootless only, host net [V] | Likely: rootless dockerd [I] | Not documented [U] | Outbound rules per instance [V] | Allowlist + outbound handlers [V] | Instance per job; deny egress |

## What this means for the design

- **Nesting a container inside the summoned compute works only where we own a
  kernel with privileges.** That means:
  - EC2 (and ECS on EC2), a VM over SSH, GKE Standard, and some Kubernetes
    clusters;
  - Fly Machines and Railway Sandboxes, which are VMs we get root in;
  - Cloudflare, rootless only [V].

  `--privileged` is refused in writing on Fargate, Cloud Run, Container Apps,
  ACI and Railway services [V].
  Unprivileged user namespaces, the thing bubblewrap needs, are reported
  blocked on Lambda and ECS [U]. They are undocumented on Cloud Run gen2 and
  Container Apps [U].
- **So the portable path is the platform's own boundary, used once per job.**
  Lambda MicroVMs, a fresh Fargate task, a fresh ACI group, an ACA dynamic
  session, a Cloud Run sandbox, and a GKE Sandbox pod each give a VM or gVisor
  boundary that the platform maintains [V].
  - The worker keeps the lease and the driver credentials.
  - The per-job unit gets the payload and nothing else.
  - This is a "dispatch the job to an isolated executor" shape, which is what
    the remote-transports plan already describes [I].
- **"One summon = one worker = many jobs" leaks state between jobs on every
  platform.** Examples: Lambda's `/tmp` and process state persist "for hours"
  [V]; a Cloud Run worker pool is never scaled down for idleness [V]. Isolation
  per _job_ needs a per-job unit, or an in-instance sandbox that is torn down
  after each job [I].
- **Credentials are the soft spot.**
  - On Lambda the execution role's keys are plain environment variables [V].
  - On ECS a relative URI in an env var unlocks the task role [V].
  - On ACA an env var pair mints managed-identity tokens [V].
  - On Cloud Run and GCE the metadata server hands out tokens to anyone who
    sends one header [V].
  - On Fly the `/.fly/api` socket mints OIDC tokens for any process with file
    access to it [V].
  - A Render one-off job inherits every environment variable of its base
    service [V].
  - A job running in the worker's process, or in a child that inherits its
    environment, can take all of these [I].
  - The minimum, even without a container: spawn the job with an explicit,
    scrubbed `env` [I].
- **Egress can be fenced on every cloud, but at the instance, not per job.**
  VPC security groups, NSGs, Direct VPC egress with firewall tags, and
  NetworkPolicy all apply to the whole summoned unit [V].
  - The worker needs its database, and the job must not reach it. Those two
    cannot share one network identity [I].
  - That is a second reason the job belongs in a separate unit. Some
    sandboxes solve it for free, by denying egress by default: Cloud Run
    sandboxes and ACA sessions [V]. Cloudflare denies it when told to
    (`enableInternet = false`) [V].
  - Fly network policies filter by port only [V]. Railway and Render offer no
    egress filter at all [V].

## Notes per platform

### 1. AWS Lambda (default functions)

- **Tenant isolation.** Workers are "bare metal Amazon EC2 AWS Nitro
  instances" running "hardware-virtualized Micro Virtual Machines (MVM) created
  by Firecracker" [V aws-lambda-wp].
  - Inside, execution environments are separated by cgroups, "a dedicated
    namespace", "seccomp-bpf – To limit the system calls", iptables and
    chroot [V aws-lambda-wp].
  - A search snippet of the whitepaper's HTML page says microVMs are "never
    shared or reused between AWS accounts", though several environments of one
    account may share one [U]. The page did not render for the fetcher, and the
    PDF read today does not contain that sentence.
- **Reuse between invocations.** "Execution environments are never reused
  across different function versions or customers, but a single environment can
  be reused between invocations of the same function version … data and state
  can persist between invocations … for hours" [V aws-lambda-wp].
  - `/tmp` "remains when the execution environment is frozen" [V
    aws-lambda-lifecycle].
  - A reset after a failed invoke "does not clear the `/tmp` directory"
    [V aws-lambda-lifecycle].
  - Background processes "resume if Lambda reuses the execution environment"
    [V aws-lambda-lifecycle].
  - So a job can plant state for the next job on the same environment [I].
- **Nesting.** The image "must be able to run on a read-only file system", and
  Lambda runs it as "a default Linux user with least-privileged permissions"
  [V aws-lambda-images]. No privileged mode or device option exists in the
  function configuration [I].
  - An open AWS containers-roadmap request (#2102, opened 2023-08-03, labelled
    Proposed) reports that `clone(2)` with a new user namespace "errors with
    `EPERM`" in "a Lambda Container" and in unprivileged ECS [V
    aws-roadmap-2102]. The behaviour itself was not reproduced today [U].
  - Docker, bubblewrap and Firecracker are therefore out [I].
- **Hardening knobs.** A read-only root and non-root user are imposed [V]. The
  only per-invoke unit is the invoke itself [I].
- **Egress / metadata.** VPC attachment; "internet egress needs NAT" [V-prior
  `../summon-compute/aws.md` §4.4]. Security groups on the function's ENIs are
  standard [U: not re-read].
  - Credentials: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
    `AWS_SESSION_TOKEN` are "The access keys obtained from the function's
    execution role", set as environment variables [V aws-lambda-env].
  - There is also a metadata endpoint at `AWS_LAMBDA_METADATA_API` (e.g.
    `169.254.100.1:9001`), gated by `AWS_LAMBDA_METADATA_TOKEN` [V
    aws-lambda-env].
- **Lambda Managed Instances (LMI)** is worse for isolation. "Multiple
  invocations can execute simultaneously within the same execution
  environment", and the environment "remains continuously active" [V
  aws-lmi-env].
- **Verdict.** No container option inside. Isolation is the platform's. To keep
  jobs apart, run one job per invoke with a scrubbed environment, and accept
  that an environment is reused. Otherwise use Lambda MicroVMs (note 2).

### 2. AWS Lambda MicroVMs (GA 2026-06-22)

GA on 2026-06-22 in five regions, ARM64 only [V-prior
`../summon-compute/aws.md` §4.7].

- **Tenant isolation.** "Lambda builds it into a snapshot … a Firecracker
  snapshot" [V aws-microvm-concepts]. A MicroVM is "an isolated compute
  environment for a single tenant, user session, or job" [V
  aws-microvm-concepts].
  - The launch blog (2026-07-10) speaks of "VM-level isolation" [V
    aws-microvm-blog]. Its phrase "no shared kernel" appeared only in search
    snippets [U].
- **Reuse.** Suspend preserves "memory and disk state" [V
  aws-microvm-concepts].
  - Every MicroVM starts from the same build snapshot, and "unique content
    during the build … is shared across all MicroVMs" [V aws-microvm-concepts].
  - A MicroVM per job, terminated after the job, gives no cross-job state [I].
- **Nesting.** Search snippets of the product page say MicroVMs offer "full
  operating system capabilities (for example, installing system packages or
  mounting filesystems)", and the blog mentions "elevated operating system
  privileges" [U, snippets and summary]. Docker inside and `/dev/kvm` are not
  documented [U].
- **Hardening / egress.** Default connectors give "public internet egress".
  You can "Create your own network connector to route outbound traffic through
  your VPC" [V aws-microvm-concepts]. How credentials reach the MicroVM
  (`executionRoleArn`) is not described [U].
- **Verdict.** Best AWS fit for a per-job boundary. The worker stays outside
  and dispatches to a MicroVM per job. The caveats are its maturity, five
  regions, and the lease hazards `aws.md` §4.7 lists [V-prior].

### 3. ECS on Fargate

- **Tenant isolation.** "Each Fargate task has its own isolation boundary and
  does not share the underlying kernel, CPU resources, memory resources, or
  elastic network interface with another task" [V aws-fargate].
  - Containers _within_ one task share the network namespace and ephemeral
    storage [V aws-fargate-sec].
- **Reuse.** Each `RunTask` is a new task. No task is reused for another run [I].
- **Nesting.**
  - "No privileged containers or access … This will affect uses cases such as
    running Docker in Docker" [V aws-fargate-sec].
  - "Additional Linux capabilities, such as CAP_SYS_ADMIN and CAP_NET_ADMIN,
    are restricted". `capabilities.add` accepts only `SYS_PTRACE` [V
    aws-fargate-sec, aws-taskdef-fargate].
  - "The `devices` parameter isn't supported" [V aws-taskdef-fargate], so no
    `/dev/kvm`.
  - The user-namespace EPERM report is the same one as in note 1 [U].
- **Hardening knobs.** `readonlyRootFilesystem`, `user`,
  `linuxParameters.capabilities.drop` (any, including `ALL`), `tmpfs`,
  `initProcessEnabled`, `disableNetworking` and `systemControls` [V
  aws-taskdef-fargate, aws-containerdef].
  - `dockerSecurityOptions` "isn't valid for containers in tasks using the
    Fargate launch type" [V aws-containerdef].
  - No seccomp profile field exists on ECS at all. The valid values are
    `no-new-privileges`, `apparmor:`, `label:` and `credentialspec:` [V
    aws-containerdef].
- **Egress / metadata.**
  - "You can use security groups and network ACLs to control inbound and
    outbound traffic" [V aws-fargate-sec]. A job task can get a security group
    that cannot reach the database [I].
  - Credentials: `curl 169.254.170.2$AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`
    [V aws-ecs-iam].
  - Task metadata: `ECS_CONTAINER_METADATA_URI_V4`, "on by default" [V
    aws-tmde].
  - A job task with **no task role** has no credentials to steal [I].
- **Verdict.** No container inside. Use the platform: one hardened task per job,
  with a job-only security group and no task role. Or, cheaper, one hardened
  worker task per summon, accepting that jobs share it.

### 4. ECS on EC2 (and ECS Managed Instances)

- **Tenant isolation.** Tasks on one container instance share its kernel.
  Isolation between them is Docker's [I; AWS contrasts this with Fargate].
- **Nesting.** `privileged`: "the container is given elevated privileges on the
  host container instance (similar to the `root` user)", which Fargate does not
  support [V aws-containerdef].
  - `devices` and every capability in `capabilities.add` are available off
    Fargate [V aws-taskdef-fargate lists them].
  - Docker-in-Docker works with `privileged` [I]. So do sysbox and gVisor
    installed on a self-built AMI [I].
  - `/dev/kvm` for Kata or Firecracker needs a nested-virtualization instance
    family (note 5) or `.metal` [V aws-nested, firecracker-start].
- **Hardening knobs.** Everything in note 3, plus `dockerSecurityOptions`
  (AppArmor/SELinux labels, `no-new-privileges`) once the agent registers
  `ECS_APPARMOR_CAPABLE`/`ECS_SELINUX_CAPABLE` [V aws-containerdef].
- **Egress / metadata.** AWS "strongly recommend[s]" blocking containers from
  IMDS [V aws-ecs-iam]:
  - bridge mode: an `iptables … --destination 169.254.169.254/32 --jump DROP`
    rule;
  - awsvpc mode: `ECS_AWSVPC_BLOCK_IMDS=true`;
  - host mode: `ECS_ENABLE_TASK_IAM_ROLE_NETWORK_HOST=false`.
  - awsvpc "is the only network mode that you can use to assign a security
    group to tasks" [V aws-ecs-iam].
- **ECS Managed Instances.** Whether it allows `privileged` was not checked
  [U].
- **Verdict.** Container option inside: **yes**. Recommended: the summoned task
  runs job containers through the host's Docker or containerd with gVisor
  (`runsc`). IMDS is blocked, and the job network has no route to the database.

### 5. EC2 or any VM or bare metal over SSH

- **Tenant isolation.** A Nitro VM on EC2 [I]. On another provider, its
  hypervisor. The VM is ours, so jobs on it share it unless we isolate them [I].
- **Nesting.** Docker, rootless Docker, bubblewrap and gVisor all run on a VM
  we own [I]. gVisor's default platform is `systrap`, which "does not require
  virtualization support" [V gvisor-platforms].
  - Firecracker "requires read/write access to `/dev/kvm`" [V
    firecracker-start]. Its guide still says "EC2 only supports KVM on `.metal`
    instance types" [V firecracker-start], but that is now out of date for
    AWS:
    - Nested virtualization is supported on "M7i | M7i-flex | M8i | …
      C7i | … C8i | … R7i | … R8i | … X8i | I7i | I7ie" [V aws-nested].
    - It is enabled with `--cpu-options "NestedVirtualization=enabled"` [V
      aws-nested].
    - Announced February 2026, widened June 2026 [V aws-nested-wn].
  - Elsewhere: GCE nested virtualization is GA, KVM only, not on E2 or Arm
    [V, Google pass: gce-nested]. Azure: a Gen2 VM size that supports nested
    virtualization, e.g. `Standard_D4s_v3` [V, Azure pass: aks-sandbox].
    Other VPS providers were not checked [U].
  - gVisor itself warns that nested virtualization "will have poor performance
    and is historically a cause of security issues … not recommended for
    production" when using its KVM platform [V gvisor-platforms].
- **Hardening knobs.** All of Docker's: `--read-only`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, seccomp, `--network none` or a custom
  network, `--runtime runsc` [I, standard Docker]. systemd's `systemd-run`
  properties, where the summoner already uses them [V-prior
  `../summon-compute/paas-ssh.md` §4].
- **Egress / metadata.**
  - EC2 IMDSv2 can be required (`HttpTokens=required`). With a PUT hop limit
    of 1, a request from a container "might not receive a response at all
    because going to the container is considered an additional network hop"
    [V aws-imds]. That is a defence for bridge-networked job containers.
  - Security groups apply to the whole VM [I]. Per-job egress is iptables or a
    Docker network [I].
- **Verdict.** Container option inside: **yes**, and this is the one place a
  Docker-based isolation layer is straightforward. Recommended:
  - Docker with gVisor (`runsc`), with no network or a restricted one, per job
    or per warm runner.
  - Firecracker or Kata only on nested-virt or `.metal` hosts.

### 6–7. Cloud Run (services, jobs, worker pools)

All facts here are from the Google pass. Keys refer to its sources, listed
below.

- **Tenant isolation.** "Each Cloud Run instance is protected (sandboxed) from
  every other by a boundary enforced by a virtual machine monitor (VMM)" [V
  run-security].
  - First generation is "based on gVisor". Second generation is "a microVM and
    provides full Linux compatibility", including "all system calls,
    namespaces, and cgroups" [V run-exec-env].
  - Jobs and worker pools are second generation only, which "cannot be changed"
    [V run-exec-env]. Only services can choose.
- **Reuse.**
  - A service instance serves many requests and may idle for up to 15 minutes
    [V run-contract].
  - A job task gets "one container instance" [V run-create-jobs]. Whether a
    retry reuses the instance is not stated [U].
  - "Cloud Run doesn't scale down worker pool instances based on idle
    instances" [V run-contract]. So a worker-pool worker serves many jobs on one
    instance [I].
- **Nesting.**
  - "Cloud Run doesn't support privileged containers" [V run-contract].
  - It also rules out "Adding or removing Linux kernel capabilities",
    "Manipulating devices", sudo/setuid and eBPF. Containers "won't have write
    access to most of the files and directories in /dev, /proc, and /sys" [V
    run-contract].
  - The container already runs "under user, network, PID, and other Linux
    namespaces" [V run-contract].
  - Whether a _nested_ unprivileged user namespace (bubblewrap) works on gen2
    is not documented either way [U]. A one-line probe on a deployment would
    settle it.
  - Google's archived experimental sample ran gVisor `runsc` inside gen2
    [V gh-diy]. It is not a supported feature.
- **Cloud Run sandboxes (Preview, launched 2026-07-10).** This is Google's
  first-party answer to exactly this question.
  - How it works: enable `--sandbox-launcher` on a service, job or worker pool,
    then call `/usr/local/gcp/bin/sandbox do -- <cmd>` from the worker [V
    run-code-exec, run-sbx-wp, run-cli].
  - Defaults, re-read independently today [V run-code-exec]:
    - "By default, all outbound traffic from the sandbox is blocked."
    - Sandboxes "don't have access to the parent workload, environment
      variables, secrets, or the Google Cloud metadata server".
    - The host root filesystem is read-only, with an in-memory overlay that is
      discarded.
  - Egress is all-or-nothing (`--allow-egress`) [V run-cli].
  - Sandboxes "share the CPU and memory allocated to the host container", with
    no per-sandbox limit flags [V run-sbx-wp, run-cli].
  - The users disagree between passes:
    - the Google pass read "non-root";
    - the independent re-read returned "execute with sudo capabilities as a
      non-root user" [V run-code-exec].
    - Treat in-sandbox privilege as unsettled [U].
  - The underlying technology is not named by Google; secondary posts say gVisor
    [U].
- **Egress / metadata.**
  - Direct VPC egress with `all-traffic` plus network tags in egress firewall
    rules works for services, jobs and worker pools [V run-vpc].
  - The metadata server (`metadata.google.internal`, header
    `Metadata-Flavor: Google`) issues service-account tokens [V run-contract].
    No documented switch turns it off [U]. Whether a VPC firewall can block it
    is [U]; it is link-local, so probably not [I].
- **Verdict.** Container option inside: **no**, and bubblewrap is unknown.
  Recommended:
  - the worker runs each job through a **Cloud Run sandbox** (Preview) with
    egress off;
  - or a Cloud Run job execution per job, with a minimal service account and
    VPC-egress deny rules;
  - gen1 is only an option for services, and gives nothing extra [I].

### 8. GKE

From the Google pass.

- **GKE Sandbox** is gVisor through RuntimeClass `gvisor`, per pod on Autopilot
  [V gke-sandbox].
  - On Standard it needs a second node pool with `cos_containerd` [V
    gke-sandbox].
  - It is incompatible with privileged containers and hostPath [V gke-sandbox].
  - Sandboxed nodes "are prevented from accessing cluster metadata" [V
    gke-sandbox].
- **Agent Sandbox** (kubernetes-sigs/agent-sandbox) is documented for GKE [V
  gke-agent]:
  - CRDs: Sandbox, SandboxTemplate, SandboxClaim and SandboxWarmPool.
  - It runs on gVisor.
  - Its default network policy explicitly blocks RFC 1918, cluster DNS and
    `169.254.0.0/16`.
  - GA status was inferred from the absence of a Preview banner [U].
  - A warm pool of sandboxed job runners is exactly the "warm pool" shape the
    user described [I].
- **Autopilot** refuses privileged containers "unless the container is deployed
  by a Google Cloud partner" [V gke-ap-sec].
- **Nested virtualization** is Standard only, and needs
  `securityContext.privileged: true`; Kata is named as a use case [V
  gke-nested].
- **User namespaces.** No GKE doc read states `hostUsers: false` support [U].
  Upstream Kubernetes made it stable in v1.36 [V k8s-userns].
- **Egress / metadata.**
  - `FQDNNetworkPolicy` is GA and egress-only, with an implicit deny; it needs
    Dataplane V2 [V gke-fqdn].
  - The GKE metadata server intercepts `169.254.169.254:80` under Workload
    Identity Federation [V gke-wi].
- **Verdict.** Container option: yes on Standard with privileged pods, which is
  not recommended. Recommended: job pods (or an Agent Sandbox warm pool) with
  `runtimeClassName: gvisor`, a restricted securityContext, and FQDN or
  NetworkPolicy egress deny.

### 9. Azure Container Apps (apps, jobs, dynamic sessions, Sandboxes)

From the Azure pass.

- **Tenant isolation.** "A Container Apps environment is a secure boundary" [V
  aca-env].
  - How Consumption replicas are isolated from other customers is not
    documented [U].
  - Dedicated workload profiles give "dedicated hardware with a single tenant
    guarantee" [V aca-plans].
  - Microsoft's multitenancy guide says a shared environment "isn't suitable for
    hostile multitenancy workloads" [V aca-mt].
- **Reuse.** A job execution "typically … runs one replica". Event jobs suit
  "when each event requires a new instance of the container" [V aca-jobs].
  "Never reused" is not stated [I].
- **Nesting.** "Azure Container Apps doesn't allow privileged containers mode
  with host-level access" [V aca-containers]. `/dev/kvm`, user namespaces and
  added capabilities are not documented [U].
- **Dynamic sessions.**
  - Custom container sessions start "in their own Hyper-V sandboxes" [V
    aca-sessions-custom].
  - Egress is `EgressDisabled` by default [V aca-session-pool]:
    - "By default, sessions are prevented from making outbound network
      requests."
  - One `identifier` maps to one session [V aca-sessions-usage].
  - The `OnContainerExit` lifecycle ends a session when the container exits,
    and a `stopSession` API exists [V aca-session-pool,
    aca-sessions-custom].
  - The pool's managed identity is hidden from sessions by default
    (`lifecycle: None`) [V aca-sessions-usage].
  - The image must serve HTTP on a target port and needs a workload-profiles
    environment. Custom-container pools run on dedicated E16 instances [V
    aca-session-pool, aca-billing].
  - Anything within one session, "including files and environment
    variables, is accessible by users of the session" [V
    aca-sessions-usage].
- **ACA Sandboxes** (`Microsoft.App/SandboxGroups`) [V aca-sandboxes]:
  - They take OCI images and support snapshots.
  - Egress rules: "domain-based allow or deny rules, CIDR-based network rules,
    and VNet integration".
  - The isolation technology and the preview/GA status were not stated [U].
- **Egress / metadata (apps and jobs).**
  - UDRs, NAT Gateway and Azure Firewall work only in workload-profiles
    environments [V aca-networking, aca-udr].
  - The required NSG rules open subnet-internal traffic [V aca-firewall].
  - Managed identity is `IDENTITY_ENDPOINT` + `IDENTITY_HEADER` env vars, not
    IMDS. `identitySettings.lifecycle: None` hides an identity from container
    code [V aca-mi].
- **Verdict.** Container option inside: **no**. Recommended: the worker (an ACA
  job or app) dispatches each job to a **fresh dynamic session identifier**,
  with `EgressDisabled` and `OnContainerExit`, then stops it. Evaluate ACA
  Sandboxes when their status is known.

### 10. Azure Container Instances

From the Azure pass.

- **Tenant isolation.**
  - "Azure Container Instances guarantees your application is as isolated in a
    container as it would be in a VM" [V aci-overview].
  - The container group is the unit [V aci-groups].
  - The confidential SKU is "a Hyper-V isolated TEE" on AMD SEV-SNP, with CCE
    policies from `az confcom` [V aci-confidential].
- **Nesting.** "ACI doesn't allow privileged container operations" [V
  aci-overview].
- **Reuse / pools.** Standby pools hand out pre-provisioned groups: "When a
  container group is consumed from the pool, the standby pool automatically
  begins to refill" [V aci-standby]. One group per job, consumed once, gives no
  cross-job state [I].
- **Egress / metadata.**
  - In a VNet, a NAT gateway "is the only supported configuration for outbound
    connectivity". NSGs and Azure Firewall are supported [V aci-vnet].
  - Linux managed identity uses IMDS at `169.254.169.254` with only a
    `Metadata:true` header [V aci-mi]. So per-job groups should carry **no**
    identity [I].
- **Verdict.** Container option inside: **no**. Recommended: platform
  isolation, one fresh group per job (from a standby pool for latency), with no
  identity and an NSG that denies the database. Use the confidential SKU where
  the host operator is also out of scope.

### 11. AKS

From the Azure pass.

- **Pod Sandboxing** "uses Kata Containers to run each sandboxed pod in a
  lightweight virtual machine (VM) with its own guest kernel", through
  `runtimeClassName: kata-vm-isolation` [V aks-sandbox].
  - It needs Azure Linux and a nested-virt Gen2 VM size [V aks-sandbox].
  - Privileged pods get "root access in the guest VM, but the containers stay
    isolated from the host" [V aks-sandbox-considerations]. So Docker-in-pod
    under Kata is plausible but untested [I].
- `hostUsers: false` needs k8s ≥ 1.33 on Azure Linux 3.0 or Ubuntu 24.04 [V
  aks-secure].
- AKS's own guidance for hostile tenants: "only trust a hypervisor" [V
  aks-secure].
- **Verdict.** Container option: yes, inside a Kata pod VM. Recommended: job
  pods on `kata-vm-isolation`, with NetworkPolicy egress deny.

### 12. Kubernetes in general (self-managed, EKS on EC2, and so on)

- **User namespaces.** "Stable since Kubernetes v1.36" through
  `pod.spec.hostUsers: false` [V k8s-userns].
  - It needs Linux ≥ 6.3, containerd ≥ 2.0 or CRI-O ≥ 1.25, and runc ≥ 1.2 or
    crun ≥ 1.9 [V k8s-userns].
  - `CAP_SYS_ADMIN` is then "Limited to the pod's user namespace only" [V
    k8s-userns, as summarised].
- **Pod Security Standards "Restricted".** `capabilities.drop` must include
  `ALL`; only `NET_BIND_SERVICE` may be added;
  `allowPrivilegeEscalation: false`; `runAsNonRoot: true`; seccomp `RuntimeDefault` or `Localhost` [V
  k8s-pss]. Baseline already forbids `privileged` [V k8s-pss].
- **Docker inside.** A privileged pod runs dockerd [I]. Sysbox is "an
  open-source … container runtime (a specialized 'runc')" that runs Docker and
  systemd in containers without privileged mode [V sysbox].
  - It is "not officially supported by Docker", with support on a "best
    effort basis" [V sysbox].
  - It claims support on GKE, EKS and AKS through a DaemonSet [V sysbox,
    vendor claim]. Managed Autopilot clusters would refuse it [I].
- **Kata** requires `/dev/kvm`: bare metal, or a VM with nested virtualization
  [U: secondary sources; consistent with firecracker-start].
- **NetworkPolicy.** "Creating a NetworkPolicy resource without a controller
  that implements it will have no effect" [V k8s-netpol]. It is L3/L4 only, with
  no FQDN rules [V k8s-netpol]. An `ipBlock` with `except` can carve out
  `169.254.169.254/32` [I from the documented `except` form].
- **Verdict.** Container option: yes where the cluster admin allows it.
  Recommended: RuntimeClass gVisor or Kata, PSS Restricted, `hostUsers: false`,
  default-deny egress.

### 13. Fly.io Machines (and Sprites)

From the PaaS pass. Several Fly facts rest on community threads, and are
marked accordingly.

- **Tenant isolation.** "Fly.io runs every workload as a Firecracker microVM on
  bare-metal servers, so hardware virtualization is the default boundary" [V
  fly-sandbox]. "Fly.io doesn't run Docker containers"; the image is unpacked
  and booted as a VM [V fly-docker].
  - Multi-container Machines "share the same kernel and VM" [V fly-multi,
    search excerpt].
- **Reuse.** The rootfs is "a blank slate on every startup", and
  `fly machine run --rm` "destroys the Machine when it stops" [V
  fly-overview].
  - A Machine _pool_ (the summoner in `paas-ssh.md` §5.1 [V-prior]) is
    therefore wiped on each restart, apart from volumes. It is shared between
    jobs within one run [I].
- **Nesting.**
  - `/dev/kvm`: Fly staff, 2023-03-28: "We currently don't support nested
    virtualisation … we've decided against it" [V fly-nested]. Nothing newer
    found [U for 2026].
  - dockerd runs inside a Machine. Fly publishes `fly-apps/docker-daemon`
    [V fly-dockerd], and a 2024 forum post covers Docker with kernel nftables
    [V fly-nft; poster's staff status not shown].
  - Root in the VM: "you have root access in your VM" is from a community
    member [V fly-dind, not staff]. The guest kernel is the Machine's own, so
    user namespaces, bubblewrap and gVisor `systrap` should work [I]. None of
    that was tested [U].
- **Hardening knobs.** Network policies per app or Machine, allow-only; once a
  rule exists, the default for that direction becomes "deny all" [V
  fly-netpol].
  - They filter by port and protocol only, with no CIDR or domain field. They
    "do not affect traffic routed through the Fly Proxy" [V fly-netpol].
  - No seccomp, capability or read-only-rootfs knobs are documented [U].
- **Egress / metadata.**
  - 6PN is org-wide. Custom private networks can "isolate tenants" [V
    fly-6pn].
  - The `/.fly/api` Unix socket mints OIDC tokens for the Machine
    (`sub: org:app:machine`) [V fly-oidc]. It is guarded only by file
    permissions [V fly-oidc-socket, community reply].
  - So a job running as root in the worker's Machine can assume any cloud
    role that trusts that token [I]. `_api.internal:4280` needs an API token
    [V fly-api], so the exposure is a `FLY_API_TOKEN` held by the worker [I].
- **Sprites** ("still Fly Machines", with "a container between you and the
  kernel") have root, run Docker, and have an egress policy that is a DNS
  allowlist enforced at the IP level. "Private IPs are always blocked", and the
  policy is read-only from inside [V fly-sprites-design, fly-sprites-net].
- **Verdict.** Container option inside: **yes** (dockerd, no KVM).
  Recommended:
  - one auto-destroying Machine per job, in its own app on a custom private
    network, with no `FLY_API_TOKEN` and a narrow OIDC trust;
  - or, inside a worker Machine, jobs as a non-root uid under gVisor `systrap`
    or Docker [I].
  - Sprites are the ready-made sandbox if their egress allowlist is wanted.

### 14. Railway (services and Sandboxes)

From the PaaS pass.

- **Services.**
  - The runtime is not named in any Railway source [U]. The reported gVisor
    use could not be confirmed.
  - Docker cannot run. Staff, 2024-04-01: "You simply can't do such things on
    Railway" [V rw-dind]. Staff, 2025-08-16: "… on Railway.. Yet." [V
    rw-priv].
  - There is no egress filter, only static IPs and IPv6 [V rw-outbound]. The
    private network is per project and environment [V rw-6pn], so a job can
    reach every `*.railway.internal` service [I].
- **Sandboxes.**
  - "Isolated Linux VMs you create on demand" [V rw-sandboxes]; the
    hypervisor is not named [U].
  - "Every sandbox includes the Docker daemon and CLI" [V rw-docker-changelog,
    2026-06-12].
  - Network is `ISOLATED` (default, internet through NAT) or `PRIVATE` [V
    rw-sandboxes; V-prior `../summon-compute/railway-vms-2026-09.md` §3.2].
    Neither blocks internet egress [V].
  - Root and `/dev/kvm` are not documented [U].
  - Idle auto-destroy, checkpoints and fork exist [V rw-sandboxes].
  - `sandboxCreate` has no dedupe key [V-prior railway-vms-2026-09.md].
- **Verdict.**
  - Services: container option **no**, and no platform knob either. Do not
    run untrusted jobs in a Railway service [I].
  - Recommended: one Railway Sandbox per job, created from a checkpoint and
    destroyed afterwards, or Docker inside a sandbox. Accept that egress stays
    open, and keep the database off the sandbox's network (`ISOLATED`) [I].

### 15. Render

From the PaaS pass.

- **Tenant isolation.** "Render uses Kubernetes (K8s) behind the scenes" [V
  render-knative].
  - Render's own guidance: its services "are containers … not designed for code
    submitted by untrusted users". For that, "call a purpose-built microVM
    sandbox" [V render-sandboxes].
- **Nesting.** The same article says blocking egress needs "privileges an
  unprivileged container doesn't have" [V render-sandboxes]. So services are
  unprivileged containers: no dockerd, no KVM [I].
  - The staff forum answer on privileged mode could not be read, because the
    forum host did not resolve [U].
- **Reuse / secrets.** A one-off job runs on a fresh instance, deprovisioned
  afterwards, but inherits "all of the base service's configured environment
  variables" [V render-jobs].
- **Egress.** No filtering [V render-ips]. "Outbound IP ranges are shared
  across _all_ services in the same region" [V render-ips].
  - The private network spans workspace and region. Environment blocking is on
    Pro and above [V render-pn].
- **Verdict.** Container option inside: **no**. Platform path: a one-off job per
  untrusted job, from a base service that holds **no** secrets. Otherwise, by
  Render's own advice, send the job to an external microVM sandbox.

### 16. Cloudflare Containers (and the Sandbox SDK)

From the PaaS pass; the Docker facts were re-read independently.

- **Tenant isolation.** "Each container instance runs inside its own VM" [V
  cf-arch]. Inside one sandbox there is no boundary: "Users can read each
  other's files!" [V cf-sandbox-sec].
- **Reuse.** "All disk is ephemeral" [V cf-arch]. The same sandbox id reaches
  the same warm instance [V cf-sandbox]. Per-job isolation therefore means a
  fresh id per job [I].
- **Nesting.** Supported since 2026-02-17, with constraints [V cf-dind,
  re-read today]:
  - "Cloudflare Containers run without root privileges, so you must use the
    rootless Docker image".
  - "Cloudflare Containers do not support iptables manipulation".
  - Inner containers need `--network=host`.
  - "Built images and containers are lost when the sandbox sleeps".
  - Rootless dockerd implies unprivileged user namespaces work [I]. `/dev/kvm`
    is not documented [U].
- **Egress / credentials.** This is the strongest model of the four PaaS [V
  cf-outbound]:
  - `enableInternet = false`.
  - `allowedHosts` becomes "a deny-by-default allowlist".
  - Programmable `outbound` handlers run beside the container, and can
    intercept HTTPS with `interceptHttps`.
  - Ports other than 80/443 are denied when internet is off.
  - The recommended pattern keeps credentials in the Worker and injects them
    in the handler [V cf-sandbox-sec]. The job never holds them.
- **Verdict.** Container option inside: **partial** (rootless, host network
  only, so no network isolation between inner containers). Recommended: one
  container or sandbox id per job, with internet off or allowlisted, and
  credentials injected by the outbound handler.

## Namespaces and seccomp inside an ordinary container

This applies to every platform that runs our image under Docker-like defaults.

- **Docker's default seccomp profile** is "moderately protective while providing
  wide application compatibility" [V docker-seccomp]. Its table says:
  - `clone`: "Deny cloning new namespaces. Also gated by `CAP_SYS_ADMIN` for
    `CLONE_*` flags, except `CLONE_NEWUSER`."
  - `unshare`: "Deny cloning new namespaces for processes. Also gated by
    `CAP_SYS_ADMIN`, with the exception of `unshare --user`."
  - `mount` is denied [V docker-seccomp].
- The wording leaves room for `unshare(CLONE_NEWUSER)` without
  `CAP_SYS_ADMIN`. Whether that works in practice also depends on the host's
  sysctls and LSMs [U].
- Even with a user namespace, bubblewrap inside containers has failed with
  "Can't mount proc on /newroot/proc: Operation not permitted" [V bwrap-284,
  a 2018 issue].
- **So bubblewrap is not a portable layer on managed container platforms**
  [I]. It is an option only on hosts we configure.
- **gVisor's rootless mode** is "mainly only suitable for `runsc do`" and
  needs user namespaces and host networking [V gvisor-rootless]. That is the
  same dependency, so it does not escape the question [I].

## Open questions

1. Does `unshare -U` or bubblewrap work inside a Cloud Run gen2 container, and
   inside an ACA replica? The only way to settle it is a probe.
2. Is the Fargate/Lambda user-namespace EPERM (roadmap #2102, 2023) still true
   in 2026? Probe it.
3. What do Cloud Run sandboxes and ACA Sandboxes run on? Is the in-sandbox user
   root with sudo, or non-root? Is either GA?
4. Can Lambda MicroVMs run dockerd? How does the execution role reach the
   MicroVM, and can it be withheld?
5. Can a Cloud Run or ACI instance block its own metadata or identity endpoint?
6. Does Fly still refuse nested virtualization in 2026, and do its network
   policies cover 6PN traffic? Do bubblewrap and gVisor `systrap` run in a
   Machine?
7. What runtime do Railway services and Render services use? Are Railway
   Sandboxes root, and can their egress be denied?

## Sources

All accessed 2026-09-29. Keys marked "(Google pass)" or "(Azure pass)" were
read by those passes.

AWS

- aws-lambda-wp — Security Overview of AWS Lambda (PDF; publication date 2022-12-27) — <https://docs.aws.amazon.com/pdfs/whitepapers/latest/security-overview-aws-lambda/security-overview-aws-lambda.pdf>
- aws-lambda-lifecycle — <https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html>
- aws-lambda-env — <https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html>
- aws-lambda-images — <https://docs.aws.amazon.com/lambda/latest/dg/images-create.html>
- aws-lmi-env — <https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-execution-environment.html>
- aws-microvm-concepts — <https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html>
- aws-microvm-blog — <https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/>
- aws-roadmap-2102 — <https://github.com/aws/containers-roadmap/issues/2102>
- aws-fargate — <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html>
- aws-fargate-sec — <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html>
- aws-taskdef-fargate — <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html>
- aws-containerdef — <https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html>
- aws-tmde — <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4-fargate.html>
- aws-ecs-iam — <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-iam-roles.html>
- aws-fargate-linux-blog (2023-08-09; sysctls and `pidMode` on Fargate) — <https://aws.amazon.com/blogs/containers/announcing-additional-linux-controls-for-amazon-ecs-tasks-on-aws-fargate/>
- aws-imds — <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html>
- aws-nested — <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html>
- aws-nested-wn — <https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual/> and <https://aws.amazon.com/about-aws/whats-new/2026/06/nested-virtualization-intel-us-gov-cloud/> (search results)

Google (Google pass, except run-code-exec, which was also re-read)

- run-exec-env — <https://docs.cloud.google.com/run/docs/about-execution-environments>
- run-contract — <https://docs.cloud.google.com/run/docs/container-contract>
- run-security — <https://docs.cloud.google.com/run/docs/securing/security>
- run-code-exec — <https://docs.cloud.google.com/run/docs/code-execution>
- run-sbx-wp — <https://docs.cloud.google.com/run/docs/configuring/workerpools/sandboxes>
- run-cli — <https://docs.cloud.google.com/run/docs/reference/sandbox-cli>
- run-create-jobs — <https://docs.cloud.google.com/run/docs/create-jobs>
- run-vpc — <https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc>
- blog-sbx — <https://cloud.google.com/blog/topics/developers-practitioners/google-cloud-run-sandboxes-are-in-public-preview/>
- gh-diy — <https://github.com/GoogleCloudPlatform/cloud-run-sandbox>
- gke-sandbox — <https://docs.cloud.google.com/kubernetes-engine/docs/concepts/sandbox-pods>
- gke-agent — <https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox>
- gke-ap-sec — <https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-security>
- gke-nested — <https://docs.cloud.google.com/kubernetes-engine/docs/how-to/nested-virtualization>
- gke-fqdn — <https://docs.cloud.google.com/kubernetes-engine/docs/how-to/fqdn-network-policies>
- gke-wi — <https://docs.cloud.google.com/kubernetes-engine/docs/concepts/workload-identity>
- gce-nested — <https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview>

Azure (Azure pass)

- aca-containers — <https://learn.microsoft.com/en-us/azure/container-apps/containers>
- aca-env — <https://learn.microsoft.com/en-us/azure/container-apps/environment>
- aca-plans — <https://learn.microsoft.com/en-us/azure/container-apps/plans>
- aca-jobs — <https://learn.microsoft.com/en-us/azure/container-apps/jobs>
- aca-networking — <https://learn.microsoft.com/en-us/azure/container-apps/networking>
- aca-udr — <https://learn.microsoft.com/en-us/azure/container-apps/user-defined-routes>
- aca-firewall — <https://learn.microsoft.com/en-us/azure/container-apps/firewall-integration>
- aca-mi — <https://learn.microsoft.com/en-us/azure/container-apps/managed-identity>
- aca-sessions-usage — <https://learn.microsoft.com/en-us/azure/container-apps/sessions-usage>
- aca-session-pool — <https://learn.microsoft.com/en-us/azure/container-apps/session-pool>
- aca-sessions-custom — <https://learn.microsoft.com/en-us/azure/container-apps/sessions-custom-container>
- aca-sandboxes — <https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview>
- aca-billing — <https://learn.microsoft.com/en-us/azure/container-apps/billing>
- aca-mt — <https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/service/container-apps>
- aci-overview — <https://learn.microsoft.com/en-us/azure/container-instances/container-instances-overview>
- aci-groups — <https://learn.microsoft.com/en-us/azure/container-instances/container-instances-container-groups>
- aci-confidential — <https://learn.microsoft.com/en-us/azure/container-instances/container-instances-confidential-overview>
- aci-vnet — <https://learn.microsoft.com/en-us/azure/container-instances/container-instances-virtual-network-concepts>
- aci-mi — <https://learn.microsoft.com/en-us/azure/container-instances/container-instances-managed-identity>
- aci-standby — <https://learn.microsoft.com/en-us/azure/container-instances/container-instances-standby-pool-overview>
- aks-sandbox — <https://learn.microsoft.com/en-us/azure/aks/use-pod-sandboxing>
- aks-sandbox-considerations — <https://learn.microsoft.com/en-us/azure/aks/considerations-pod-sandboxing>
- aks-secure — <https://learn.microsoft.com/en-us/azure/aks/secure-container-access>

Kubernetes, runtimes and sandboxes

- k8s-userns — <https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/>
- k8s-pss — <https://kubernetes.io/docs/concepts/security/pod-security-standards/>
- k8s-netpol — <https://kubernetes.io/docs/concepts/services-networking/network-policies/>
- sysbox — <https://github.com/nestybox/sysbox>
- firecracker-start — <https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md>
- gvisor-platforms — <https://gvisor.dev/docs/user_guide/platforms/>
- gvisor-rootless — <https://gvisor.dev/docs/user_guide/rootless/>
- docker-seccomp — <https://docs.docker.com/engine/security/seccomp/>
- bwrap-284 — <https://github.com/containers/bubblewrap/issues/284>

Fly, Railway, Render, Cloudflare (PaaS pass, except cf-dind, which was also
re-read)

- fly-sandbox — <https://fly.io/learn/virtual-sandbox/>
- fly-docker — <https://docs.fly.io/blueprints/working-with-docker/>
- fly-multi — <https://fly.io/docs/machines/guides-examples/multi-container-machines/> (search excerpt)
- fly-overview — <https://docs.fly.io/machines/overview/>
- fly-nested — <https://community.fly.io/t/nested-virtualization-on-fly-io/11778> (staff reply, 2023-03-28)
- fly-dind — <https://community.fly.io/t/docker-in-docker-on-fly/3674>
- fly-nft — <https://community.fly.io/t/kernel-nftables-support/17669>
- fly-dockerd — <https://github.com/fly-apps/docker-daemon>
- fly-netpol — <https://docs.fly.io/machines/guides-examples/network-policies/>
- fly-6pn — <https://docs.fly.io/networking/private-networking/>
- fly-oidc — <https://docs.fly.io/security/openid-connect/>
- fly-oidc-socket — <https://community.fly.io/t/non-root-access-to-fly-api-oidc-socket-expected-or-is-there-a-workaround/28662>
- fly-api — <https://docs.fly.io/machines/api/working-with-machines-api/>
- fly-sprites-design — <https://fly.io/blog/design-and-implementation/>
- fly-sprites-net — <https://docs.fly.io/sprites/concepts/networking/>
- rw-sandboxes — <https://docs.railway.com/sandboxes>
- rw-docker-changelog — <https://railway.com/changelog/2026-06-12-docker-in-sandboxes>
- rw-dind — <https://station.railway.com/feedback/docker-in-docker-d07c4730>
- rw-priv — <https://station.railway.com/feedback/allow-services-to-be-run-in-privileged-m-8c66b22b>
- rw-outbound — <https://docs.railway.com/networking/outbound-networking>
- rw-6pn — <https://docs.railway.com/networking/private-networking/how-it-works>
- render-knative — <https://render.com/blog/knative>
- render-sandboxes — <https://render.com/articles/what-are-sandboxes-and-why-your-agents-should-use-them>
- render-jobs — <https://render.com/docs/jobs>
- render-ips — <https://render.com/docs/outbound-ip-addresses>
- render-pn — <https://render.com/docs/private-network>
- cf-arch — <https://developers.cloudflare.com/containers/platform-details/architecture/>
- cf-outbound — <https://developers.cloudflare.com/containers/platform-details/outbound-traffic/>
- cf-sandbox — <https://developers.cloudflare.com/sandbox/>
- cf-sandbox-sec — <https://developers.cloudflare.com/sandbox/concepts/security/>
- cf-dind — <https://developers.cloudflare.com/sandbox/guides/docker-in-docker/> and <https://developers.cloudflare.com/changelog/post/2026-02-17-docker-in-docker/>
