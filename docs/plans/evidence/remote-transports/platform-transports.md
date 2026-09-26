# Platform transports: what can reach a remote executor, and over what

This is evidence for Phase 2 of [`../../worker-runtimes.md`](../../worker-runtimes.md):
remote execution (§4.2.8 `RemoteEndpointTarget`, §5 the remote-worker contract).
A bun-jobs worker runs next to the queue's database. It **connects out** to a
*remote executor* on some compute platform, pushes one job attempt, and needs
progress, logs, heartbeats, health and the result back. The user wants this
over HTTP, SSE, WebSocket, TCP, UDP and similar transports.

Whether that works depends on two things. The first is what each platform lets
**in** to the executor. The second matters only for a reversed design, in which
the executor dials the worker or a relay: what the platform lets **out**.

Researched **2026-09-25**. Nothing here was built or run in the repo.

## How to read the marks

| Mark | Meaning |
|---|---|
| **[V]** | Read today, 2026-09-25, in a primary source: vendor docs, a quotas page, a changelog, or a vendor's own blog or staff post where that is the only statement. The key after the mark names the page in [Sources](#sources). |
| **[V-prior]** | Carried from an earlier file in this repo and not re-read today. The cell names the file: `plan §3.x` is `worker-runtimes.md` (verified 2026-09-22), and `aws.md`, `google-azure.md` and `paas-ssh.md` are in `../summon-compute/` (verified 2026-09-25). |
| **[I]** | Inference. The reasoning is given in the cell or in the notes under the table. It is a claim to test. |
| **[U]** | No primary source was found today. It is not a fact, and nothing should rest on it. |

These marks are load-bearing. A prior round of this research withdrew three
claims because inferences had been written as findings. **No inference here
has been upgraded.** Where a vendor documents no figure, the cell says so.

**Method.** The pages were read by four research passes (AWS, Google, Azure,
and edge/PaaS/Kubernetes), which recorded a verbatim quote for every [V].

- **Google** pages, and the pages the edge pass marked "curl", were fetched raw, so their quotes are exact.
- **The rest** went through a summarising fetch, which can lightly paraphrase headings and table cells. That matters most for AWS What's New posts, the AWS blog and ELB product pages. Before quoting any of those word for word, re-open them. They are flagged † in [Sources](#sources).
- **Spot-checks.** Five of the more surprising claims were re-read independently while this file was assembled. All five held:
  - Vercel WebSockets
  - Railway's limits
  - Cloudflare's 125 s 524
  - Gateway API UDPRoute GA
  - Heroku routing

---

## 1. Conclusions first

### 1.1 Which transports are broadly hostable

Here is how many of the ~35 platform shapes below accept each transport inbound
to the executor:

| Transport | Inbound support | Where it works | Where it does not |
|---|---|---|---|
| **HTTP/1.1 request/response** | **Universal** | Every platform that has an inbound path at all | Cloud Run jobs, Cloud Run worker pools (L4 only), Render background workers, ACA jobs and LMI have no inbound HTTP |
| **Streamed response (chunked / SSE / NDJSON)** | **Near universal, but often capped or buffered by default** | Streaming is on by default on Cloud Run, Vercel, Workers, Fly, Railway, Render, Heroku and plain containers | Opt-in and bounded on Lambda Function URLs (`RESPONSE_STREAM`, 200 MB, not in a VPC) and API Gateway REST (`STREAM`, 15 min, 5 min idle). **Not available** on API Gateway HTTP API or ALB→Lambda. Netlify caps a stream at 60 s |
| **WebSocket** | **Wide, not universal** | ALB, NLB, Cloud Run (≤60 min), GCP ALB, ACA, App Service, AKS via Gateway API, CF Workers/DO/Containers, Railway (no limit), Render, Heroku (55 s idle), Vercel (**beta**, ≤ max duration), Deno Deploy, Lambda MicroVMs, Kubernetes | **Not** on a Lambda Function URL, ALB→Lambda, API Gateway HTTP/REST or App Runner [U]. API Gateway's WebSocket API terminates the socket itself, so the executor never holds it. Azure Functions, Netlify and Cloud Run functions are [U] |
| **HTTP/2 end-to-end / gRPC** | **Partial** | Cloud Run (h2c opt-in; gRPC all stream types), ALB (gRPC target version), GCP ALB, ACA, Fly (`h2_backend`), Kubernetes/Gateway `GRPCRoute`, Lambda MicroVMs | Heroku terminates HTTP/2 at the router and forwards HTTP/1.1. App Runner is 1.0/1.1 only. Lambda Function URLs, Railway, Render, Vercel and CF Workers are [U] for gRPC to the process |
| **Raw TCP** | **Rare, and never on FaaS** | AWS NLB (ECS/EC2/EKS), GCP passthrough or proxy NLB, GKE LoadBalancer, GCE, ACA TCP ingress (**VNet environments only**), ACI, AKS, Fly `[[services]]`, Railway TCP Proxy, Render **private** services (private network only), Cloud Run **worker pools** (Direct VPC ingress, **VPC only**), CF Spectrum (**Enterprise add-on**; origin is an IP or hostname, not a Worker), Kubernetes, VM | **Every FaaS**, Cloud Run services, App Service, App Runner, Heroku, Vercel, Netlify, Deno Deploy, CF Workers (inbound TCP "coming soon"), CF Containers |
| **UDP** | **Rarest** | AWS NLB (120 s fixed idle), GCP passthrough NLB and GKE LoadBalancer, GCE, ACI, AKS LoadBalancer, Fly (dedicated IPv4 and `fly-global-services` only), Spectrum (Enterprise), Railway **private network only**, Kubernetes (where the provider supports it), VM | Everything else. [U] on Render, and on Cloud Run worker pools (the docs say "L4" and name only TCP) |

**The shape of the matrix:**

- **HTTP with a streamed response** reaches almost every platform, so it is
  the one transport a design can assume.
- **WebSocket** reaches most of them, but its lifetime is set by the platform,
  not by us. Idle and maximum-duration limits range from 55 s (Heroku idle)
  through 60 min (Cloud Run) and 2 h (API Gateway) to unlimited (Railway).
- **Raw TCP and UDP are available only where the user runs a container or VM
  behind an L4 load balancer they own**, or on Fly. Those are exactly the
  platforms where an ordinary pull-mode `BunQueueWorker` already runs today,
  unchanged (plan §3.5 [V-prior]).

So for bun-jobs, TCP and UDP **buy reach nowhere that HTTP lacks it**. They
only add protocol surface.

### 1.2 The reversed-connection verdict

**A reversed connection is the practical way to reach a *long-running*
executor that has no inbound path.** Such an executor is one of:

- a Cloud Run worker pool
- a Render background worker
- an ACA app or job with ingress off
- an ECS task with no load balancer
- anything behind NAT or a firewall

In a reversed connection the executor dials out to the worker or a relay, and
work flows back down that socket. It is also the only way to carry raw TCP
from hosts that allow outbound TCP but no inbound TCP. Outbound rules are far
more permissive than inbound ones:

- every platform in §2 allows outbound TCP
- Cloudflare Workers allow it through `connect()`
- Vercel's Node runtime allows it

The three systems the brief names do exactly this, and say why:

- **Inngest Connect.** Its value is to "avoid public endpoints or work behind
  firewalls" [V inngest-connect].
- **Temporal.** "The Worker makes only outbound connections … Nothing connects
  inbound" [V temporal-ecs].
- **Hatchet.** Its gRPC `Dispatcher` has the worker dial out and the server
  push assignments [V-prior plan §3.8].

**It breaks in five places:**

1. **Not on FaaS, at all.** A reversed socket needs a process that stays alive
   between jobs. Lambda freezes, request-billed Cloud Run suspends CPU, and
   Azure Functions does not track background threads (plan §3.4 [V-prior]).
   Inngest states the consequence outright: "Serverless runtimes (AWS Lambda,
   Vercel, etc.) are not supported" for Connect [V inngest-connect].
   - Durable Objects can hold an *outbound* WebSocket, but it "do[es] not
     hibernate" and pins the object for "up to 15 minutes per connection"
     [V cf-do-ws].
   - So FaaS remains HTTP push, the design §5 already chose.
2. **The worker must be reachable, which turns it into a server.** §5.2 chose a
   streamed response precisely so that "bun-jobs never has to expose an
   inbound write surface to the internet" (plan §5.2 / §10.6 [V-prior]). A
   reversed connection gives that up: the worker needs a listener, TLS, auth
   and a public or peered address.
3. **A relay becomes infrastructure.** Several workers share one queue, so an
   executor cannot know which worker to dial. Inngest, Temporal and Hatchet all
   solve this with **a server that every worker and executor dials**, which is
   their product. bun-jobs has only the database.
   - A rendezvous service is a new always-on component, with its own HA, auth
     and scaling.
   - Using the database as the rendezvous is today's pull mode (plan §3.2)
     [I].
4. **No scale-from-zero.** A reversed socket exists only while the executor
   runs, so nothing can start a stopped executor through it. It needs
   summon-compute (Phase 1.5) alongside it [I].
5. **Egress still has idle clocks.** The dialled-out socket crosses the
   platform's NAT and egress path, which drop quiet flows silently:
   - Cloud Run: 10 min idle to a VPC, 20 min to the internet [V gcr-contract]
   - AWS NAT gateway: 350 s [V aws-nat]
   - Azure outbound public IP: fixed at 4 min [V az-lb-reset]
   - GCP firewall connection tracking: a packet at least every 10 min [V gcp-fw]
   - Global Accelerator: 340 s TCP, and "you cannot use TCP keep-alive packets"
     [V aws-ga]

   Heartbeats must be **application data**, sent more often than the shortest
   of these.

**Recommendation that follows [I].** Keep HTTP push with a streamed response as
the one specified transport. Add the reversed WebSocket (§5.2 already defers it
"for one specific problem: a remote with no public URL") as a **re-framing of
the same envelopes**, and only for long-running hosts.

**Do not specify raw TCP or UDP.** They reach no platform that WebSocket over
an outbound connection cannot. UDP would also force the protocol to rebuild
ordering, retransmission and congestion control. Every UDP path here also has
a ≤120 s fixed flow timeout (NLB 120 s, GCP passthrough 60 s, Global
Accelerator 30 s, Linux conntrack 30 s/120 s), and AWS NLB rehashes a flow to
"a new target" after its idle timeout. A NAT or load balancer can therefore
silently re-route a UDP "session" mid-job.

If a user truly needs a raw-TCP executor, it should be an adapter (a Faktory-
style line protocol over a dialled-out TCP socket) that sits behind the same
envelope semantics. It should not be a second specification (plan §3.8's
Inngest lesson [V-prior]).

### 1.3 The worst silent-breakage traps (full list in §4)

1. **A proxy that buffers SSE.** The stream "works" but progress arrives in one
   lump at the end, and heartbeats arrive late enough to look like a dead
   executor.
   - nginx buffers by default (`proxy_buffering on`) [V nginx-proxy].
   - Cloudflare Tunnel buffers "unless the origin server includes the
     `Content-Type: text/event-stream` response header" [V cf-tunnel].
   - Cloudflare's response body buffering defaults to "Standard", which
     inspects a prefix [V cf-buffering].
   - API Gateway REST and Lambda Function URLs both default to `BUFFERED`
     [V aws-apigw-stream, aws-furl-modes].
   - App Engine flexible buffers "in 64k-blocks" [V gae-flex].
   - Opposite trap: **ingress-nginx defaults `proxy-buffering` to "off"**, the
     reverse of stock nginx [V ingress-nginx-cm]. Behaviour flips depending on
     which nginx sits in front.
2. **An idle timeout that closes a quiet WebSocket or stream with no error the
   application sees as meaningful.**
   - ALB's 60 s default, which **HTTP/2 PING frames do not reset** [V aws-alb-attrs]
   - Heroku's 55 s rolling window [V heroku-routing]
   - nginx and ingress-nginx at 60 s [V nginx-ws, ingress-nginx-misc]
   - Azure Load Balancer at 4 min, whose default is to "silently drop flows"
     [V az-lb-reset]
   - The classic GCP Application LB, which closes **even an active** WebSocket
     at the 30 s backend timeout [V gcp-lb-timeouts]
3. **A timeout that fails the response but not the work.** The executor keeps
   running a job its caller has already abandoned, and a retry runs it twice.
   - Azure Functions: after 230 s "the Azure Load Balancer will time out and
     return an HTTP 502 … The function will continue running" [V az-func-http].
   - Cloud Run: returns 504, but "the container instance that served the
     request is not terminated" [V gcr-timeout].
   - Lambda streaming: responses "are not interrupted … when the invoking client
     connection is broken" and are billed in full [V aws-lambda-stream].
4. **A keepalive that does not count.**
   - HTTP/2 PING does not reset ALB's idle timer [V aws-alb-attrs].
   - Global Accelerator ignores TCP keepalive packets [V aws-ga].
   - Heroku counts only bytes sent [V heroku-routing].

   Heartbeats must be application bytes on the stream.
5. **A UDP flow re-routed after a short idle.**
   - AWS NLB: after 120 s, "a new flow … may go to a new target" [V aws-nlb].
   - GCP passthrough NLB: connection tracking entries expire at 60 s, fixed
     [V gcp-netlb-ct].
   - Linux conntrack: UDP 30 s [V linux-ct].

---

## 2. The matrix

The column abbreviations are:

| Column | Meaning |
|---|---|
| **H1** | Inbound HTTP/1.1 |
| **H2/gRPC** | HTTP/2 to the process, or gRPC |
| **Stream** | Response streaming or SSE, and any buffering |
| **WS** | Inbound WebSocket, and its idle or maximum limits |
| **TCP** | Raw inbound TCP, and where TLS terminates |
| **UDP** | Inbound UDP |
| **Out** | Outbound TCP or WebSocket from the executor, which is what a reversed design needs |
| **Bounds** | What limits one long attempt |
| **Health** | The platform's own health mechanism |

Keys in brackets resolve in [Sources](#sources).

### 2.1 AWS

| Platform | H1 | H2/gRPC | Stream | WS | TCP | UDP | Out | Bounds | Health |
|---|---|---|---|---|---|---|---|---|---|
| **Lambda Function URL** | Yes; the request is mapped to a JSON event, so the function never sees a socket [V aws-furl-invoke] | Examples show `HTTP/2 200` at the client edge. Not stated as a guarantee [U] | `RESPONSE_STREAM` mode, 200 MB. First 6 MB uncapped, then **2 MBps**. **Not supported in a VPC.** Node managed runtimes only; Bun needs a custom Runtime API integration or Lambda Web Adapter [V aws-furl-modes, aws-lambda-stream]. Default is `BUFFERED`, 6 MB [V aws-furl-modes] | No statement [U]. Impossible given the event mapping [I] | No | No | Yes by default; **once VPC-attached, needs NAT** [V aws-lambda-vpc] | 900 s. **No Function-URL-specific maximum is documented** [U] (plan §3.7 [V-prior] flagged the same gap; re-checked across six pages today). Bound = the sync invoke timeout, 900 s [I]. A stream keeps billing after the client disconnects [V aws-lambda-stream]. 429 above reserved concurrency [V aws-furl-config] | None of its own. Lambda has no inbound probe [I] |
| **API Gateway HTTP API** | Yes | [U] | **No response streaming**: "Response streaming is only supported for REST APIs" [V aws-apigw-stream, aws-apigw-compare] | Separate API type (below) [I] | No | No | n/a | **30 s integration timeout, not raisable**; 10 MB payload [V aws-apigw-http-quotas] | n/a |
| **API Gateway REST API** | Yes | [U] | `STREAM` transfer mode (Nov 2025), `HTTP_PROXY`/`AWS_PROXY` only. **Up to 15 min.** Idle timeout **5 min** on Regional/private and **30 s on edge-optimized**. First 10 MB free, then 2 MB/s. No request streaming. SSE is named as a use case [V aws-apigw-stream, aws-apigw-stream-news†] | No | No | No | n/a | Buffered: 29 s default, raisable above 29 s on Regional/private at a throttle cost (2024) [V aws-apigw-rest-quotas, aws-apigw-29s†]. 310 s idle connection timeout [V aws-apigw-rest-quotas] | n/a |
| **API Gateway WebSocket API** | Only `$connect` upgrade | No | n/a | **Terminated at API Gateway.** The backend is invoked once per message (29 s integration timeout) and pushes by SigV4-signed `POST …/@connections/{id}`. **The executor never holds the socket** [V aws-apigw-ws-overview, aws-apigw-ws-conn; the consequence is I]. **2 h maximum, 10 min idle, 32 KB frames, 128 KB messages, no binary media** [V aws-apigw-ws-quotas] | No | No | n/a | 2 h / 10 min idle, then close code 1001 [V aws-apigw-ws-overview] | n/a |
| **ALB → ECS / EC2 / IP target** | Yes | HTTP/2 on HTTPS listeners. Target protocol version HTTP/1.1 (default), **HTTP/2 or gRPC**, with "unary, client-side streaming, server-side streaming, and bi-directional streaming" [V aws-alb-tg, aws-alb-listeners] | ALB buffering of chunked or SSE responses: **no primary statement** [U] | **Yes, native** [V aws-alb-listeners] | No (HTTP/HTTPS listeners only) | No | Yes | **Idle timeout 60 s by default (1–4,000 s).** "Application Load Balancers do not support HTTP/2 PING frames. These do not reset the connection idle timeout." Client keepalive 3,600 s by default [V aws-alb-attrs]. Deregistration delay 300 s by default [V aws-alb-attrs] | HTTP/HTTPS/gRPC target health checks; gRPC path `/AWS.ALB/healthcheck`. **"Health checks do not support WebSockets"** [V aws-alb-hc] |
| **ALB → Lambda target** | Yes | gRPC cannot use Lambda targets [V aws-alb-tg] | Neither API Gateway (since superseded, see REST above) nor ALB-to-Lambda "support chunked transfer encoding" [V aws-blog-stream†, 2023] | **"WebSockets are not supported. Upgrade requests are rejected with an HTTP 400"** [V aws-alb-lambda] | No | No | — | 1 MB request and response bodies [V aws-alb-lambda] | Off by default for Lambda targets [V aws-alb-lambda] |
| **NLB → ECS / EC2 / EKS** | Via TCP pass-through | Pass-through; ALPN policies on TLS listeners [V aws-nlb-listeners] | Pass-through [I] | Yes on TCP, TLS, TCP_UDP and TCP_QUIC listeners [V aws-nlb-listeners] | **Yes.** TCP, **TLS (termination optional)**, TCP_UDP, QUIC, TCP_QUIC. No `lambda` targets [V aws-nlb-listeners, aws-nlb-tg] | **Yes.** UDP and TCP_UDP. A dualstack NLB needs IPv6 target groups for UDP [V aws-nlb-listeners] | Yes | **TCP idle 350 s by default, 60–6,000 s** (Sep 2024) [V aws-nlb, aws-nlb-idle†]. TLS listener fixed at 350 s. **UDP idle fixed at 120 s**, after which a flow "may go to a new target" [V aws-nlb]. Above 350 s the target ENI's conntrack timeout must match [V aws-nlb] | TCP/HTTP/HTTPS. **UDP and QUIC targets are checked with non-UDP health checks** [V aws-nlb-hc] |
| **Lambda Managed Instances** | **No documented inbound path to the instance.** Invocations are pulled from the Runtime API (`/next`) [V aws-lambda-custom]. Function URLs and streaming on LMI are not addressed [U] | — | [U] | [U] | No | No | Yes; always in your VPC [V aws-lmi-net] | Sync 900 s; async and event-source up to 5,400 s (announced 2026-09-09) [V aws-lambda-90min†, aws-lambda-quotas] | Lambda's own; `process.on()` unavailable in Node [V aws-lmi-node] |
| **Lambda MicroVMs** (GA 2026-06-22; *not in the brief*) | Yes, over a per-MicroVM HTTPS URL | **HTTP/1.1, HTTP/2, WebSockets, gRPC and SSE** [V aws-microvm-net] | SSE listed [V aws-microvm-net] | Yes [V aws-microvm-net] | Port 8080 by default, chosen per request by `X-aws-proxy-port` [V aws-microvm-net]. Raw TCP [U] | [U] | Public egress by default; VPC through a connector [V aws-microvm-net] | **8 h maximum**; up to 128 concurrent connections per MicroVM at 16 vCPU [V aws-lambda-quotas]. Auto-suspend is driven by *inbound* traffic (`aws.md` §4.7 [V-prior]). Endpoint idle and request timeouts [U]. JWE token required in `X-aws-proxy-auth` [V aws-microvm-net] | Lifecycle hooks (`aws.md` §4.7 [V-prior]) |
| **ECS / Fargate** | Behind an ALB or NLB, `ip` target type [V aws-ecs-lb] | Via ALB | Via ALB [U] | Via ALB or NLB | Via NLB; container ports `tcp` and `udp` [V aws-ecs-td] | **Yes, via NLB** (since 2020, platform 1.4) [V aws-fargate-udp†] | Yes, given a public IP or NAT [V aws-fargate-net] | `stopTimeout` defaults to 30 s, **maximum 120 s** [V aws-ecs-td]. **Service Connect's `perRequestTimeout` defaults to 15 s for HTTP/HTTP2/gRPC**; its `idleTimeout` is 5 min for HTTP and 1 h for TCP [V aws-ecs-sc] | Container `healthCheck` (CMD, interval 5–300 s); a task failing LB checks "is stopped and restarted" [V aws-ecs-td, aws-ecs-nlb] |
| **EC2** | Anything the security group allows [I] | Anything [I] | Anything [I] | Anything [I] | Anything [I] | Anything [I] | Yes | Set by whatever LB or NAT is in front. NAT gateway idle is 350 s [V aws-nat] | LB target health checks, or your own |
| **App Runner** | **Closed to new customers since 2026-04-30**; "we do not plan to introduce new features" [V aws-apprunner-rel, aws-apprunner-avail] | "HTTP 1.0 and HTTP 1.1" only [V aws-apprunner-dev] | [U] | [U] | No | No | Yes | **120 s total per request**, body read included [V aws-apprunner-dev] | App Runner's own |
| *CloudFront in front* | — | WS over HTTP/1.1 only [V aws-cf-ws] | Buffering [U] | Yes; **10 min idle** [V aws-cf-ws, aws-cf-limits] | — | — | — | Origin response timeout 1–120 s, default 30 s, applied **between packets** [V aws-cf-origin] | — |
| *Global Accelerator in front* | — | — | — | — | Yes | Yes | — | **TCP 340 s, UDP 30 s, not customisable; "You cannot use TCP keep-alive packets to maintain an open connection"** [V aws-ga] | — |

### 2.2 Google Cloud

| Platform | H1 | H2/gRPC | Stream | WS | TCP | UDP | Out | Bounds | Health |
|---|---|---|---|---|---|---|---|---|---|
| **Cloud Run service** | Yes. TLS terminates at Cloud Run and the request arrives "as HTTP/1 or gRPC … without TLS" [V gcr-contract] | HTTP/2 is downgraded to HTTP/1 except gRPC. **End-to-end HTTP/2 is opt-in and requires h2c.** "All gRPC types, streaming or unary" work [V gcr-http2, gcr-grpc] | Yes; needs `Transfer-Encoding: chunked` [V gcr-https]. **Front-end buffering is not documented** [U]. 32 MiB response cap unless chunked [V gcr-quotas] | Yes, no configuration. **Subject to the request timeout (default 5 min, maximum 60 min)**; "Don't enable HTTP/2 end-to-end". Affinity is best effort. An open WS bills as instance-based [V gcr-ws] | **No.** Inbound is "Public/Internal HTTP/gRPC" [V gcr-model]; no Direct VPC ingress for services [V gcr-contract] | No [I from the same] | Yes. 50,000 open connections per instance, 700 new/s. **Idle 10 min to VPC and 20 min to the internet**; streams "occasionally terminated" on infrastructure restarts [V gcr-quotas, gcr-contract] | **Request timeout 60 min maximum; on timeout a 504, but "the container instance … is not terminated"** [V gcr-timeout]. 60 min also bounds gRPC streams and chunked responses [I: the timeout is per request; not stated for those cases]. Request-based billing gives CPU only during requests [V gcr-billing] | Startup (HTTP/TCP/gRPC), liveness (HTTP/gRPC), readiness (HTTP/gRPC; **ignored under session affinity**). A TCP startup probe is added by default [V gcr-hc] |
| **Cloud Run worker pool** | **No URL and no load-balanced endpoint** [V gcr-wp, gcr-model] | — | — | — | **Per-instance private IP, "IP based L4 ingress with Direct VPC", from inside the VPC only**; "the container must listen for TCP connections" [V gcr-model, gcr-contract, gcr-dvpc] | [U]: the docs say "L4" and "TCP" only | Yes; the same 10/20 min idle | No request timeout described [I]. "Worker pools don't idle" (CPU always allocated) [V gcr-contract] | Startup (HTTP/TCP/gRPC) and liveness (HTTP/gRPC); no readiness [V gcr-wp-hc]. The docs contradict each other on autoscaling [V gcr-wp vs gcr-model] |
| **Cloud Run job** | **None**: "shouldn't listen on a port" [V gcr-contract, gcr-model] | — | — | — | — | — | Yes | Task ≤168 h (1 h with GPUs) [V gcr-quotas] | — |
| **Cloud Run functions** | HTTP functions over a run.app URL; "a function is a Cloud Run service" [V gcf-compare] | As Cloud Run [I] | Streaming samples exist [V gcf-stream]. **2nd-gen streamed response capped at 10 MB** per the functions quotas, which contradicts Cloud Run's quotas [V gcf-quotas vs gcr-quotas]; unresolved | [U] | No | No | Yes; **port 25 blocked** [V gcf-bp] | HTTP 60 min, event-driven 9 min [V gcf-compare, gcf-quotas] | As Cloud Run [I] |
| **Cloud Run instances** (Preview; *not in the brief*) | A per-instance run.app URL, "Long-lived (can run for days/weeks)" [V gcr-model] | [U] | [U] | [U] | [U] | [U] | [U] | 6.25 % CPU baseline outside burst; a `"timeout": "3600s"` field [V gcr-model, gcr-instances]. Whether the 60 min rules apply [U] | [U] |
| **External Application LB** (in front of GCE, GKE or serverless) | Yes | HTTP/2, **h2c (not classic)**, gRPC end-to-end over HTTP/2 [V gcp-lb-https] | Buffering is **not documented** [U]. The backend timeout covers until "the last byte of the HTTP response", and data past it "is dropped" [V gcp-lb-timeouts] | Yes. **Global: active WS closed at 24 h; idle WS at the backend timeout. Classic: every WS, idle or active, closed at the backend timeout. Regional: idle only** [V gcp-lb-timeouts] | No | No | — | Backend service timeout **30 s by default** (60 min fixed for serverless NEGs); GFE effective maximum 86,400 s; client keepalive 610 s (not WS); GFE maintenance restarts are not delayed [V gcp-lb-timeouts, gcp-sneg] | LB health checks; GKE Ingress takes them from the readinessProbe (only at creation) [V gke-ingress] |
| **Proxy Network LB** | — | — | — | — | TCP or SSL, terminated at the LB [V gcp-proxy-nlb] | No | — | **The backend timeout is an idle timeout, default 30 s** [V gcp-backend-svc] | LB health checks |
| **Passthrough Network LB** (and GKE `LoadBalancer`) | Pass-through | Pass-through | Pass-through | Pass-through | **Yes, not a proxy (DSR)**; source IP preserved [V gcp-netlb] | **Yes**: TCP, UDP, `L3_DEFAULT` [V gcp-netlb] | — | Backend timeout ignored. **Connection tracking expires after 60 s idle, not modifiable** (internal: 600 s default) [V gcp-netlb-ct, gcp-int-netlb] | LB health checks |
| **GKE** | Services plus Ingress or Gateway | Gateway `GCPBackendPolicy` h2c/HTTP2 backends; Ingress through the `app-protocols` annotation [V gke-gw-config, gke-h2] | Per ALB | Per ALB mode: `gke-l7-global-external-managed` = global, `gke-l7-gxlb` = **classic** [V gke-gw]. Which mode the default `gce` Ingress builds [U] | `LoadBalancer` = passthrough NLB [V gke-svc-lb] | **Yes; mixed TCP+UDP on one Service GA from 1.36.2-gke.1498000** [V gke-mixed] | Yes | Ingress `BackendConfig.timeoutSec` and Gateway `timeoutSec` **both default to 30 s** [V gke-ingress-cfg, gke-gw-config] | Kubernetes probes, plus LB checks (http, https, grpc, http2, tcp) [V gke-gw-config] |
| **Compute Engine** | Anything | Anything | Anything | Anything | External IPs accept "TCP, UDP, ICMP, IPIP, AH, ESP, SCTP, and GRE" [V gcp-fw] | Yes [V gcp-fw] | Yes; **TCP 25 blocked by default** [V gcp-fw] | **Firewall connection tracking needs a packet at least every 10 min** [V gcp-fw] | Yours, or a MIG or LB's |

### 2.3 Azure

| Platform | H1 | H2/gRPC | Stream | WS | TCP | UDP | Out | Bounds | Health |
|---|---|---|---|---|---|---|---|---|---|
| **Functions** (all plans) | HTTP trigger | General HTTP/2 [U] | Node.js HTTP streams (`@azure/functions` ≥4.3.0, `enableHttpStream`) [V az-func-stream]. GA status [U]. **Whether a stream escapes the 230 s cap [U]; measure it** | No statement [U]. The documented pattern is the SignalR / Web PubSub bindings [V az-signalr] | No | No | VNet on Flex, Premium and Dedicated; **not Consumption**, which allows 600 active outbound connections per instance [V az-func-scale] | **230 s for an HTTP response on every plan**, "because of the default idle timeout of Azure Load Balancer". After that, a 502 while **"the function will continue running"** [V az-func-scale, az-func-http]. Execution: Consumption 5/10 min; Flex, Premium, Dedicated and ACA unbounded [V az-func-scale] | App Service health check, on Premium and Dedicated only [V az-appsvc-hc] |
| **Container Apps (app)** | Yes, through Envoy | "HTTP/1.1 and HTTP/2"; "WebSocket and gRPC" [V az-aca-ingress]; `transport: auto/http/http2/tcp` [V az-aca-ingress-how] | Buffering [U] | **Yes** [V az-aca-ingress]. Whether the 240 s request timeout applies to WS or SSE [U] | **TCP ingress; external TCP only in a VNet environment**; up to 5 extra TCP ports per app [V az-aca-ingress, az-aca-ingress-how] | **None documented**; the transport enum has no `udp` [I] | Yes | **HTTP request timeout 240 s** [V az-aca-ingress]. Premium ingress idle timeout 4–30 min (default 4), which requires a dedicated workload profile [V az-aca-premium]. Whether that lifts the 240 s [U] | Startup, liveness and readiness probes, **TCP or HTTP(S) only; no exec, no gRPC** [V az-aca-probes] |
| **Container Apps (job)** | **No ingress** (`google-azure.md` [V-prior]) | — | — | — | — | — | Yes | `replicaTimeout` (`google-azure.md` [V-prior]) | Probes |
| **Container Instances** | On a public or private IP | Anything [I] | Anything [I] | Anything [I] | **Yes; the ports list is `TCP`/`UDP`**; **no port remapping** [V az-aci-api, az-aci-trouble] | **Yes** [V az-aci-api] | Yes | No built-in LB [I]. The IP "subject to change" [V az-aci-faq]. Public IP idle timeout [U] | **exec and httpGet probes only (no tcpSocket)** [V az-aci-api] |
| **AKS** | Via ingress or LB | Via Application Gateway for Containers or NGINX | **AGC: set `timeouts.request: 0s` for SSE; idle fixed at 5 min** [V az-agc-sse] | AGC: "only supported when using Gateway API"; its default HTTP probe marks WS backends unhealthy [V az-agc-ws] | LB Service, L4 [V az-lb-overview] | **Yes**; "For cluster UDP services, no health probes" [V az-aks-lb] | Yes; SNAT ports reclaimed after 30 min idle [V az-aks-lb] | **LB idle 4–100 min (default 4); AKS turns on TCP reset** [V az-aks-lb]. App-routing NGINX: Microsoft patches it only "through November 2026" [V az-aks-approuting] | Kubernetes probes |
| **App Service** | Yes; ports 80/443 only [V az-appsvc-net] | HTTP/2 over HTTPS; unencrypted stays 1.1 [V az-appsvc-cfg] | [U] | **Setting "Web sockets" must be enabled** [V az-appsvc-cfg]; ~50K per instance on Linux [V az-appsvc-limits]. WS idle timeout [U] | No [I, since only 80/443 are exposed] | No [I] | Yes; 128 preallocated SNAT ports, reclaimed after 4 min [V az-appsvc-snat] | **230 s (Windows) / 240 s (Linux) response** [V az-appsvc-timeout]. Without Always On the app unloads after 20 min idle [V az-appsvc-cfg] | Health check: 1 min pings, removed after 10 failures (configurable 2–10), replaced after 1 h [V az-appsvc-hc] |
| *Application Gateway in front* | — | — | — | Always on; **"The request timeout value in HTTP Settings also applies to the WebSocket session"** [V az-appgw-ws] | — | — | — | Request timeout **20 s by default**; up to 86,400 s for a private backend, 240 s for an external one [V az-appgw-http] | HTTP/HTTPS probes only |
| *Azure Load Balancer* | — | — | — | — | Yes | Yes | — | Idle 4–100 min (default 4); **default behaviour: "silently drop flows"** unless TCP reset is on. "Idle timeout isn't supported for UDP load-balancing rules". Outbound public IP locked at 4 min [V az-lb-reset] | Probes |

### 2.4 Cloudflare

| Platform | H1 | H2/gRPC | Stream | WS | TCP | UDP | Out | Bounds | Health |
|---|---|---|---|---|---|---|---|---|---|
| **Workers** | `fetch()` handler; HTTP/3 too [V cf-protocols] | gRPC into a Worker: no doc either way [U] | `ReadableStream` bodies [V cf-streams]. **Response body buffering defaults to "Standard", which inspects a prefix**; "None" streams [V cf-buffering]. Effect on small SSE events [U]: test it | **Yes** through `WebSocketPair`; 32 MiB messages [V cf-ws]. Cloudflare "will close a WebSocket connection when no data is transmitted … for a period of time"; **the period is not stated** [V/U cf-net-ws]. Network releases "may restart servers, which terminates WebSockets" [V cf-net-ws] | **No**: "not possible to make an inbound TCP connection to your Worker"; "coming soon" [V cf-tcp] | No [I: no UDP handler exists] | `connect()` TCP and outbound WS through `fetch` + `Upgrade`. **6 simultaneous connections, which outbound WS counts against**. Port 25, Cloudflare IPs, private IPs and localhost blocked [V cf-tcp, cf-limits, cf-ws]. `node:dgram` is a stub that throws (plan §3.6 [V-prior]) | **No wall limit for HTTP while the client stays connected**; CPU 30 s default, 5 min maximum on Paid; `waitUntil` ≤30 s [V cf-limits] | None of its own |
| **Durable Objects** | Via a Worker | — | — | **As the WS server, with hibernation.** "Outgoing WebSockets do not hibernate" and pin the object "for up to 15 minutes per connection"; **"Code updates disconnect all WebSockets"** [V cf-do-ws] | No | No | As Workers | Plan §3.6 [V-prior] | — |
| **Containers** (GA 2026-04-13) | Only through a Worker → Durable Object [V cf-ctr-arch] | [I] inherits the Workers gap | Through `fetch` | **Yes, only through `fetch`/`switchPort`; `containerFetch` "Does not support WebSockets"** [V cf-ctr-class] | **No**: "End-users cannot make non-HTTP TCP or UDP requests to a Container instance" [V cf-ctr-arch] | **No** [V cf-ctr-arch] | `enableInternet` defaults to true [V cf-ctr-class] | `sleepAfter` "10m"; ≤15 min after SIGTERM [V cf-ctr-class, cf-ctr-arch]. Activity means inbound requests, or `renewActivityTimeout()` (`paas-ssh.md` §5.2 [V-prior]) | `pingEndpoint`, **at startup only** [V cf-ctr-class]; ongoing liveness [U] |
| **Spectrum** | — | — | — | — | **Yes**, an L4 proxy that "forwards TCP payloads as-is"; PROXY v1/v2 [V cf-spectrum-cfg, cf-spectrum-pp] | **Yes**; **fragmented UDP is dropped** [V cf-spectrum-lim] | — | **Custom TCP/UDP requires Enterprise plus the Spectrum add-on** [V cf-spectrum, cf-spectrum-plans]. The origin is an IP or DNS name; a Worker cannot be one [I]. Idle timeouts [U] | [U] |
| *CF proxy in front of any origin* | — | gRPC toggle; the origin must speak TLS + HTTP/2 over ALPN on 443 [V cf-grpc] | **Tunnel buffers unless `Content-Type: text/event-stream`** [V cf-tunnel] | "Supported on all Cloudflare plans" [V cf-conn-limits] | — | — | — | **Proxy Read 125 s → 524** (Enterprise up to 6,000 s); Proxy Idle 900 s [V cf-524, cf-conn-limits] | — |

### 2.5 PaaS and edge

| Platform | H1 | H2/gRPC | Stream | WS | TCP | UDP | Out | Bounds | Health |
|---|---|---|---|---|---|---|---|---|---|
| **Fly.io Machines** | `http` handler | **`h2_backend`** (h2c) "if your application needs HTTP/2 (like gRPC does)" [V fly-services]; gRPC over a shared IP since 2023 [V fly-h2†] | Through the proxy [I] | Not stated on any page read [U]. Works over a no-handler TCP service [I] | **Yes; `[[services]] protocol = "tcp"`**. Handlers `tls` (terminates), `http`, `pg_tls`, `proxy_proto`; **no handlers = raw TCP forwarded as-is** [V fly-config, fly-services] | **Yes: bind `fly-global-services`, dedicated IPv4 required**, MTU ~1300 [V fly-udp] | Yes | **TCP idle-timeout closing removed (2023)** [V fly-tcp-idle†]. `http_options.idle_timeout` exists; its default [U]. `kill_timeout` defaults to 5 s, maximum 300 s [V fly-config]. **Autostop is driven by proxy traffic**; Machines with no services are never auto-stopped [V fly-autostop] | Service `tcp`/`http` checks **gate routing**; top-level `[checks]` do not; checks never restart [V fly-hc] |
| **Railway** | Yes | "HTTP/1.1 and HTTP/2" at the edge [V railway-limits]. HTTP/2 or gRPC to the container [U] | Yes, while data flows [I] | **"Exempt from these duration and inactivity limits, and can stay open indefinitely, even while idle"** (WS over HTTP/1.1) [V railway-limits] | **TCP Proxy** for public non-HTTP [V railway-tcp] | Public: none documented [U]. **Private network carries any IPv4/IPv6 traffic, UDP included** [V railway-private] | Yes | **HTTP up to 15 min if data keeps flowing; closed after 5 min with no data**; idle HTTP/1.1 connections closed after 60 s [V railway-limits] | **Deploy-time only**: "does not monitor the healthcheck endpoint after the deployment has gone live" [V railway-hc] |
| **Render** | Web services | "HTTP/2" appears in the feature list [V render-web]. To the service [U] | Yes [I] | **No fixed timeout; closes when the instance is replaced** (deploy or maintenance) [V render-ws] | **Private services: "almost any port … any protocol", on the private network only.** Public raw TCP [U] | [U] | Yes. **Background workers "don't receive any incoming network traffic"** [V render-bg, render-privnet] | **HTTP responses up to 100 min** [V render-vs-vercel] | TCP (or path) checks every 5 s; traffic removed after ~15 s of failures, restart after 60 s [V render-hc] |
| **Heroku** | Yes | **HTTP/2 terminates at the router; HTTP/1.1 is forwarded to the dyno** [V heroku-routing]. So no gRPC to a dyno [I] | Yes if a byte flows every <55 s [I]; 1 MB router buffer per connection [V heroku-routing] | **Yes; "The normal Heroku HTTP routing timeout rules apply"** [V heroku-ws] | **"TCP Routing" not supported** [V heroku-routing] | No [I] | Yes | **30 s to first byte (H12), then a 55 s rolling idle window (H15/H28)** [V heroku-routing, heroku-timeout] | Dyno manager checks automatically; Docker `HEALTHCHECK` not supported [V heroku-container]; bind `$PORT` within 60 s or R10 [V heroku-startup] |
| **Vercel Functions** | Yes | [U] | **Streaming, with SSE examples** [V vercel-stream] | **Yes, public beta (changelog 2026-06-22), native `Bun.serve()` WS included**; "close when a Vercel Function reaches its maximum duration"; pinned to one instance; needs Fluid compute. Bun caveats: no `drain`, no `-1` backpressure [V vercel-ws, vercel-ws-news] | No [I] | No [I] | Yes. Node coverage; **1,024 file descriptors including TCP sockets** [V vercel-limits] | 300 s (Hobby) / 800 s / **1,800 s (beta)**; the limit "includes … streamed responses" → 504; 4.5 MB body [V vercel-limits] | — |
| **Netlify Functions** | Yes | [U] | **Streaming is capped at 60 s and 20 MB** [V netlify-api, netlify-cfg] | [U] | No | No | Undocumented (plan §3.5 [V-prior]) | Sync 60 s, background 15 min; Edge 50 ms CPU, 40 s header timeout [V netlify-cfg, netlify-edge] | — |
| **Deno Deploy** (new) | `Deno.serve` [I] | [U] | Response bytes keep the app alive [V deno-runtime] | WS "that actively transmit data (including ping/pong frames) also keep the application alive" [V deno-runtime], which implies inbound WS works [I] | [U] | [U] | Yes; **port 443 needs `Deno.connectTls`** [V deno-limits] | **Stopped after 5 s–10 min with no requests or response bytes**; SIGINT, then SIGKILL after 5 s; evictable mid-request [V deno-runtime]. No published request cap (plan §3.5 [V-prior]) | [U] |

### 2.6 Generic

| Platform | H1 | H2/gRPC | Stream | WS | TCP | UDP | Out | Bounds | Health |
|---|---|---|---|---|---|---|---|---|---|
| **Kubernetes** (any) | Service plus Ingress or Gateway | **`GRPCRoute` GA since Gateway API v1.1**; Ingress is HTTP only and "no longer being developed" [V k8s-ingress, gw-api] | Depends on the ingress controller. **ingress-nginx: `proxy-buffering` "off" by default** [V ingress-nginx-cm] | Needs timeouts raised: ingress-nginx read/send default to **60 s** ("higher than one hour" advised) [V ingress-nginx-misc] | **Service `TCP`; Gateway `TCPRoute`/`TLSRoute` GA (v1.6 / v1.5)** [V k8s-svc-proto, gw-api] | **Service `UDP` (on a LoadBalancer "depends on the cloud provider"); `UDPRoute` GA since v1.6.0**; mixed-protocol LB stable since 1.26 [V k8s-svc-proto, k8s-svc, gw-api]. Which controllers implement TCP/UDPRoute [I: varies] | Yes | Whatever the ingress, LB and NAT impose. **ingress-nginx was retired in March 2026: no releases or security fixes after that** [V ingress-nginx-home, k8s-blog-retire] | **exec, httpGet, tcpSocket, grpc** (gRPC stable since 1.27, plaintext by default) [V k8s-probes] |
| **Plain VM / SSH host** | Anything | Anything | Anything, unless you put nginx in front: then `proxy_buffering on` and a 60 s `proxy_read_timeout` [V nginx-proxy] | Anything; nginx closes one after 60 s of silence [V nginx-ws] | Anything | Anything | Anything | Only the network path: cloud firewall connection tracking (GCP 10 min [V gcp-fw]), NAT (AWS 350 s [V aws-nat]), Linux conntrack (UDP 30 s / stream 120 s, TCP established 5 days) [V linux-ct] | systemd, or your own |

---

## 3. Notes on specific rows

- **Lambda Function URL maximum duration is still undocumented.** Plan §3.7
  flagged this gap [V-prior]. Today's pass re-checked six pages and found no
  figure: `urls-configuration`, `urls-invocation`, `config-rs-invoke-furls`,
  `furls-http-invoke-decision`, the quotas page and the FAQ [U].
  - The 900 s bound is an inference from the invoke being synchronous.
  - Even on LMI, "Synchronous invocations retain the existing 15-minute maximum
    timeout" [V aws-lambda-90min†].
  - Plan §3.7's instruction stands: measure it before shipping a Lambda adapter.
- **API Gateway REST streaming (Nov 2025) is new since plan §3.7.** It gives an
  HTTP-push executor up to 15 min of streamed progress behind API Gateway, but
  the **stream must emit something at least every 5 min** on Regional endpoints
  and **every 30 s on edge-optimized ones** [V aws-apigw-stream].
- **Lambda MicroVMs are the one Lambda shape with a real inbound socket.** They
  take HTTP/2, gRPC, WebSocket and SSE for up to 8 h [V aws-microvm-net,
  aws-lambda-quotas].
  - `aws.md` §4.7 [V-prior] found that auto-suspend is driven by *inbound*
    traffic. That is hostile to a pull worker, but it fits a push executor: the
    push *is* the inbound traffic [I].
  - Endpoint timeouts are [U].
- **The GCP WebSocket premise in the brief was half right.** "30 s bounds a
  WebSocket's lifetime" is true only of the **classic** Application LB:
  - Global: an active WebSocket lives to 24 h, and only an idle one dies at the
    backend timeout.
  - Regional: likewise, only an idle one dies at the backend timeout
    [V gcp-lb-timeouts].
  - On GKE, `gke-l7-gxlb` is classic [V gke-gw].
- **Cloud Run worker pools *can* take inbound connections, but only L4 TCP to a
  per-instance private IP from inside the VPC** [V gcr-contract, gcr-dvpc].
  So an executor in a worker pool is reachable from a bun-jobs worker in the
  same VPC with no URL, no GFE and no request timeout. Finding the instance IPs
  is the caller's problem [I]. Outside the VPC, a reversed connection is the
  only route.
- **Vercel WebSockets (beta, 2026-06-22) are new since plan §3.5.** Plan §3.5
  says Vercel functions are suspended between invocations [V-prior], and that
  still holds. The WS closes at the function's maximum duration (≤1,800 s, and
  that tier is beta) [V vercel-ws, vercel-limits]. So a WS-framed executor on
  Vercel is bounded exactly like an HTTP one.
- **Azure's 230 s cap is the tightest HTTP bound among the major clouds'
  serverless offerings.** A streamed response might survive it, since the cap
  is described as an idle timeout, but no source says so [U]. Measure it.
- **Several limits are fixed by the provider and cannot be configured:**
  - API Gateway WS: 2 h and 10 min
  - NLB: UDP 120 s, and TLS listeners 350 s
  - Global Accelerator: TCP 340 s and UDP 30 s
  - GCP passthrough NLB connection tracking: 60 s
  - AGC idle: 5 min
  - Heroku: 55 s

  A protocol that cannot heartbeat inside the smallest of these on its chosen
  path will fail on that path however it is configured [I].

---

## 4. Where intermediaries silently break a protocol

"Silently" means the application sees either nothing or a generic error, never
"a proxy did this".

### 4.1 Buffering: the stream arrives, but late or all at once

| Intermediary | Default | Escape | Source |
|---|---|---|---|
| nginx (`proxy_pass`) | **`proxy_buffering on`** | Response header `X-Accel-Buffering: no`, or `proxy_buffering off` | [V nginx-proxy] |
| ingress-nginx | **`proxy-buffering` "off"**, but `proxy-request-buffering` "on" | This is the opposite of stock nginx. Do not assume either | [V ingress-nginx-cm] |
| Cloudflare Tunnel | **Buffered** "unless the origin … includes `Content-Type: text/event-stream`" | Send that content type. NDJSON progress would be buffered [I] | [V cf-tunnel] |
| Cloudflare response body buffering | **"Standard"**, which inspects a prefix | "None" | [V cf-buffering] |
| API Gateway REST | **`BUFFERED`** | `STREAM` transfer mode | [V aws-apigw-stream] |
| Lambda Function URL | **`BUFFERED`** (6 MB) | `RESPONSE_STREAM`, which is not available in a VPC | [V aws-furl-modes, aws-lambda-stream] |
| ALB → Lambda | Neither chunked nor streamed | Use a Function URL or REST API instead | [V aws-blog-stream†] |
| App Engine flexible (GFE) | **Buffered in 64 KB blocks** | `X-Accel-Buffering: no` | [V gae-flex] |
| Cloud Run / GCP ALB / AWS ALB / ACA / CloudFront | **Not documented** | Test it | [U] |
| Heroku router | Buffers up to 1 MB of response per connection (a flow-control window, not a hold) | — | [V heroku-routing] |

**Design consequence [I].** The progress stream should:

- send `Content-Type: text/event-stream` even when the body is NDJSON-shaped, or
  use SSE framing outright, which also satisfies Cloudflare Tunnel;
- set `X-Accel-Buffering: no`;
- send a heartbeat frame on a clock.

The gateway should then treat a missing heartbeat as **"the path is
buffering, or the executor is dead"**, and the handshake should be able to tell
the two apart. One way: the executor's first frame carries a timestamp, and the
gateway measures when it arrives.

### 4.2 Idle and lifetime timeouts that drop quiet connections

| Path | Idle | Maximum | What the application sees | Source |
|---|---|---|---|---|
| Heroku router | **55 s rolling** (30 s to first byte) | — | H15/H28 close | [V heroku-routing] |
| nginx / ingress-nginx | **60 s** read/send | — | Close | [V nginx-ws, ingress-nginx-misc] |
| AWS ALB | **60 s** default (≤4,000 s). **HTTP/2 PING does not reset it** | Client keepalive 3,600 s | Close | [V aws-alb-attrs] |
| GCP classic ALB / proxy NLB / GKE Ingress and Gateway | **30 s** backend timeout | Classic: the same 30 s even when active | Close; the response is truncated | [V gcp-lb-timeouts, gcp-backend-svc, gke-ingress-cfg] |
| GCP global ALB | Idle WS at the backend timeout | **24 h** | Close | [V gcp-lb-timeouts] |
| GCP passthrough NLB | **60 s** connection tracking, fixed | — | The next packet is a new flow and may hash elsewhere [I] | [V gcp-netlb-ct] |
| AWS NLB | TCP 350 s (60–6,000); **UDP 120 s, fixed** | — | **TCP: RST on the next data. UDP: may go to a new target** | [V aws-nlb] |
| AWS NAT gateway | **350 s** | — | RST | [V aws-nat] |
| Global Accelerator | **TCP 340 s, UDP 30 s; TCP keepalives do not count** | — | Drop | [V aws-ga] |
| Azure Load Balancer | **4 min** (4–100); **default "silently drop flows"** | — | **Nothing**, unless TCP reset is enabled (AKS turns it on) | [V az-lb-reset, az-aks-lb] |
| Azure outbound public IP | **4 min, locked** | — | Drop | [V az-lb-reset] |
| Azure App Service / Functions | — | **230–240 s** to respond | 502; the function keeps running | [V az-func-http, az-appsvc-timeout] |
| Azure Container Apps | Premium ingress 4–30 min | 240 s request | Timeout | [V az-aca-ingress, az-aca-premium] |
| Azure Application Gateway | — | **20 s** default request timeout, which "also applies to the WebSocket session" | Close | [V az-appgw-http, az-appgw-ws] |
| Azure AGC | **5 min, fixed** | — | Close; not drained on scale-in | [V az-agc-sse] |
| API Gateway WS | **10 min** | **2 h** | 1001 | [V aws-apigw-ws-quotas] |
| API Gateway REST stream | **5 min** (edge: 30 s) | 15 min | Close | [V aws-apigw-stream] |
| CloudFront | WS **10 min**; origin timeout 30 s between packets | — | Close / 504 | [V aws-cf-limits, aws-cf-origin] |
| Cloudflare proxy | Proxy Idle 900 s; **Read 125 s** before first response | WS idle close, period **unstated** | 524 / close | [V cf-524, cf-conn-limits, cf-net-ws] |
| Cloud Run (inbound) | — | Request timeout ≤60 min, **WS included** | 504 / disconnect; **the instance continues** | [V gcr-ws, gcr-timeout] |
| Cloud Run (outbound) | **10 min to VPC, 20 min to the internet** | Occasional resets | Dead socket | [V gcr-contract] |
| GCP VPC firewall | **10 min** (needs a packet) | — | Return traffic dropped | [V gcp-fw] |
| Railway | 5 min with no data (HTTP) | 15 min HTTP; **WS unlimited** | Close | [V railway-limits] |
| Linux conntrack (any NAT host) | **UDP 30 s**, UDP stream 120 s; TCP established 5 days | — | Flow forgotten | [V linux-ct] |

### 4.3 Health checks that cannot see the protocol

The platforms' own health mechanisms constrain what a remote executor must
expose. The design must **coexist** with them, and can reuse some:

- **They check HTTP (or TCP, or gRPC), not your socket.**
  - ALB: "Health checks do not support WebSockets" [V aws-alb-hc].
  - NLB: UDP targets must be checked by TCP, HTTP or HTTPS [V aws-nlb-hc].
  - AKS: "For cluster UDP services, no health probes" [V az-aks-lb].
  - AGC's default HTTP probe marks WebSocket backends unhealthy
    [V az-agc-ws].

  So **an executor needs a plain HTTP health endpoint even when its job
  transport is WS or TCP**. Inngest Connect requires exactly this: a
  `readinessProbe` returning 200 "when the connection to Inngest is active"
  [V inngest-connect].
- **Some checks run only at deploy time.**
  - Railway "does not monitor the healthcheck endpoint after the deployment has
    gone live" [V railway-hc].
  - Fly's top-level `[checks]` "do not affect request routing", and failing
    checks never restart a Machine [V fly-hc].
  - Cloudflare Containers' `pingEndpoint` runs at startup only [V cf-ctr-class].

  On these platforms, a dead executor keeps receiving pushes until the
  protocol's own heartbeat notices [I]. **The protocol's heartbeat is the only
  health signal bun-jobs can rely on everywhere.**
- **Readiness is not honoured everywhere.**
  - Cloud Run keeps routing to an instance that fails readiness when session
    affinity is on [V gcr-hc].
  - GKE Ingress reads the readinessProbe only when the Ingress is created
    [V gke-ingress].
- **The probe types differ, so an executor should serve plain HTTP/1 `GET` for
  health** [I]. It is the one type every platform with checks can use:
  - Kubernetes: exec, http, tcp, grpc [V k8s-probes]
  - ACA: TCP/HTTP only [V az-aca-probes]
  - ACI: exec/httpGet only [V az-aci-api]
  - Fly: tcp/http [V fly-hc]
  - Cloud Run liveness: HTTP/gRPC [V gcr-hc]
- **Deploys and maintenance cut connections by design.**
  - Durable Object code updates "disconnect all WebSockets" [V cf-do-ws].
  - Cloudflare network releases terminate WebSockets [V cf-net-ws].
  - Render closes WebSockets when an instance is replaced [V render-ws].
  - GFE maintenance ignores the backend timeout [V gcp-lb-timeouts].
  - Cloud Run outbound streams are "occasionally terminated" [V gcr-contract].
  - Vercel keeps existing WebSockets on the *old* deployment [V vercel-ws].

  A job attempt must therefore survive a transport reconnect, **addressed by
  job and attempt, never by connection**. This is plan §3.8's Trigger.dev
  `(runId, snapshotId)` lesson [V-prior].

### 4.4 Other traps

- **Request timeouts that fail the caller but not the work.** In each case the
  gateway sees a failure, retries, and the job runs twice. The
  idempotency-key-in-cache design in plan §5.8 is what makes that safe [I].
  - Azure Functions: 502 and "continue running" [V az-func-http].
  - Cloud Run: 504, and the instance "is not terminated" [V gcr-timeout].
  - Lambda streaming: billed after disconnect [V aws-lambda-stream].
  - LMI: a timed-out invocation's code keeps running (plan §3.7 [V-prior]).
- **ECS Service Connect `perRequestTimeout` defaults to 15 s.** It cuts a long
  push between services in the same cluster unless it is raised, or set to 0
  [V aws-ecs-sc].
- **UDP fragmentation and MTU.**
  - Spectrum drops fragmented UDP [V cf-spectrum-lim].
  - Fly's effective UDP MTU is ~1,300 bytes [V fly-udp].
  - A job envelope does not fit in one datagram [I].
- **Capability probing by `import` fails on Workers.** `node:dgram` imports
  fine and throws at call time (plan §3.6 [V-prior]).

---

## 5. Open items this file could not close

| # | Unknown | Why it matters | How to close it |
|---|---|---|---|
| 1 | Lambda Function URL maximum request duration | Bounds an HTTP-push attempt on Lambda | Measure (plan §7.2 tier 3) |
| 2 | Whether Cloud Run's GFE, AWS ALB, ACA's Envoy and CloudFront buffer SSE/NDJSON | Progress and heartbeat latency | A measured test, with a timestamp in each frame |
| 3 | Whether an Azure Functions stream survives past 230 s | Whether Azure can host attempts >4 min at all | Measure |
| 4 | Cloudflare's WebSocket idle period; Spectrum's idle timeouts | Heartbeat interval on CF paths | Measure, or ask the account team |
| 5 | Fly `http_options.idle_timeout` default; WebSockets through Fly's `http` handler | Heartbeat interval on Fly | Docs or measurement |
| 6 | HTTP/2 or gRPC reaching the process on Railway, Render, Vercel and Workers | Only if a gRPC transport is ever specified (§1.2 says do not) | — |
| 7 | UDP on Render; UDP to Cloud Run worker pools; Deno Deploy inbound TCP/UDP | Only if UDP is specified (§1.2 says do not) | — |
| 8 | WebSockets on Azure Functions, Netlify, Cloud Run functions and App Runner | WS-framed executors on those | Docs or measurement |
| 9 | Whether GKE's default `gce` Ingress builds a classic or a global ALB | WS lifetime on GKE (30 s versus 24 h) | Inspect a created LB |
| 10 | Endpoint idle and request timeouts on Lambda MicroVMs | A promising host for push | Docs or measurement |
| 11 | Cloud Run functions' streamed-response cap: 10 MB (functions quotas) versus none (Cloud Run quotas) | Progress volume on functions | Measure |

---

## Sources

All accessed **2026-09-25**.

- **†** marks a page read through a summarising fetch. Its quote is as relayed; re-open the page before quoting it verbatim.
- **Google pages** were fetched raw. Most showed "Last updated 2026-09-21" to "2026-09-24".
- **Cloudflare pages:** the edge pass fetched `cf-tcp`, `cf-524`, `cf-tunnel` raw. Others went through WebFetch, whose extractor may lightly paraphrase table cells.

### AWS

| Key | URL |
|---|---|
| aws-furl-config | https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html |
| aws-furl-invoke | https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html |
| aws-furl-modes | https://docs.aws.amazon.com/lambda/latest/dg/config-rs-invoke-furls.html |
| aws-furl-decision | https://docs.aws.amazon.com/lambda/latest/dg/furls-http-invoke-decision.html |
| aws-lambda-stream | https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html |
| aws-lambda-quotas | https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html |
| aws-lambda-90min† | https://aws.amazon.com/about-aws/whats-new/2026/09/aws-lambda-90-minute-function/ (posted 2026-09-09) |
| aws-lambda-vpc | https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc-internet.html |
| aws-lambda-custom | https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html |
| aws-lmi-net | https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-networking.html |
| aws-lmi-node | https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-nodejs-runtime.html |
| aws-microvm-net | https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html (also https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms/ †, posted 2026-06-22) |
| aws-apigw-http-quotas | https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html |
| aws-apigw-compare | https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html |
| aws-apigw-rest-quotas | https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html |
| aws-apigw-29s† | https://aws.amazon.com/about-aws/whats-new/2024/06/amazon-api-gateway-integration-timeout-limit-29-seconds/ (posted 2024-06-04) |
| aws-apigw-stream | https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html |
| aws-apigw-stream-news† | https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis/ (posted 2025-11-19) |
| aws-apigw-ws-quotas | https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html |
| aws-apigw-ws-overview | https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html |
| aws-apigw-ws-conn | https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html |
| aws-alb-listeners | https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html |
| aws-alb-tg | https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html |
| aws-alb-attrs | https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html |
| aws-alb-hc | https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html |
| aws-alb-lambda | https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html |
| aws-blog-stream† | https://aws.amazon.com/blogs/compute/introducing-aws-lambda-response-streaming/ (2023) |
| aws-nlb-listeners | https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-listeners.html |
| aws-nlb-tg | https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-target-groups.html |
| aws-nlb | https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html |
| aws-nlb-idle† | https://aws.amazon.com/about-aws/whats-new/2024/09/aws-network-load-balancer-tcp-idle-timeout/ (posted 2024-09-03) |
| aws-nlb-hc | https://docs.aws.amazon.com/elasticloadbalancing/latest/network/target-group-health-checks.html |
| aws-ecs-td | https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html |
| aws-fargate-net | https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html |
| aws-ecs-lb | https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html (load balancer section) |
| aws-ecs-nlb | https://docs.aws.amazon.com/AmazonECS/latest/developerguide/nlb.html |
| aws-fargate-udp† | https://aws.amazon.com/about-aws/whats-new/2020/07/aws-fargate-for-amazon-ecs-now-supports-udp-load-balancing-with-network-load-balancer/ |
| aws-ecs-sc | https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect-concepts-deploy.html |
| aws-apprunner-rel | https://docs.aws.amazon.com/apprunner/latest/relnotes/relnotes.html |
| aws-apprunner-avail | https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html |
| aws-apprunner-dev | https://docs.aws.amazon.com/apprunner/latest/dg/develop.html |
| aws-cf-ws | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html |
| aws-cf-limits | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html |
| aws-cf-origin | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html |
| aws-ga | https://docs.aws.amazon.com/global-accelerator/latest/dg/introduction-how-it-works.html |
| aws-nat | https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-troubleshooting.html |

### Google Cloud

| Key | URL |
|---|---|
| gcr-contract | https://docs.cloud.google.com/run/docs/container-contract |
| gcr-http2 | https://docs.cloud.google.com/run/docs/configuring/http2 |
| gcr-grpc | https://docs.cloud.google.com/run/docs/triggering/grpc |
| gcr-ws | https://docs.cloud.google.com/run/docs/triggering/websockets |
| gcr-https | https://docs.cloud.google.com/run/docs/triggering/https-request |
| gcr-quotas | https://docs.cloud.google.com/run/quotas |
| gcr-timeout | https://docs.cloud.google.com/run/docs/configuring/request-timeout |
| gcr-model | https://docs.cloud.google.com/run/docs/resource-model |
| gcr-hc | https://docs.cloud.google.com/run/docs/configuring/healthchecks |
| gcr-billing | https://docs.cloud.google.com/run/docs/configuring/billing-settings |
| gcr-wp | https://docs.cloud.google.com/run/docs/deploy-worker-pools |
| gcr-wp-hc | https://docs.cloud.google.com/run/docs/configuring/workerpools/healthchecks |
| gcr-dvpc | https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc |
| gcr-instances | https://docs.cloud.google.com/run/docs/instances/create-and-manage-instances |
| gcf-compare | https://docs.cloud.google.com/run/docs/functions/comparison |
| gcf-quotas | https://docs.cloud.google.com/functions/quotas |
| gcf-stream | https://docs.cloud.google.com/functions/docs/samples/functions-response-streaming |
| gcf-bp | https://docs.cloud.google.com/run/docs/tips/functions-best-practices |
| gcp-lb-https | https://docs.cloud.google.com/load-balancing/docs/https |
| gcp-lb-timeouts | https://docs.cloud.google.com/load-balancing/docs/https/request-distribution |
| gcp-sneg | https://docs.cloud.google.com/load-balancing/docs/negs/serverless-neg-concepts |
| gcp-backend-svc | https://docs.cloud.google.com/load-balancing/docs/backend-service |
| gcp-proxy-nlb | https://docs.cloud.google.com/load-balancing/docs/tcp |
| gcp-netlb | https://docs.cloud.google.com/load-balancing/docs/network |
| gcp-netlb-ct | https://docs.cloud.google.com/load-balancing/docs/network/ext-netlb-traffic-distribution |
| gcp-int-netlb | https://docs.cloud.google.com/load-balancing/docs/internal/int-netlb-traffic-distribution |
| gcp-fw | https://docs.cloud.google.com/vpc/docs/firewalls |
| gae-flex | https://docs.cloud.google.com/appengine/docs/flexible/how-requests-are-handled |
| gke-svc-lb | https://docs.cloud.google.com/kubernetes-engine/docs/concepts/service-load-balancer |
| gke-mixed | https://docs.cloud.google.com/kubernetes-engine/docs/how-to/mixed-protocol-lb |
| gke-ingress | https://docs.cloud.google.com/kubernetes-engine/docs/concepts/ingress |
| gke-ingress-cfg | https://docs.cloud.google.com/kubernetes-engine/docs/how-to/ingress-configuration |
| gke-h2 | https://docs.cloud.google.com/kubernetes-engine/docs/how-to/secure-traffic-management |
| gke-gw | https://docs.cloud.google.com/kubernetes-engine/docs/concepts/gateway-api |
| gke-gw-config | https://docs.cloud.google.com/kubernetes-engine/docs/how-to/configure-gateway-resources |

### Azure

| Key | URL |
|---|---|
| az-func-scale | https://learn.microsoft.com/en-us/azure/azure-functions/functions-scale |
| az-func-http | https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-http-webhook-trigger |
| az-func-stream | https://learn.microsoft.com/en-us/azure/azure-functions/node-http-stream |
| az-signalr | https://learn.microsoft.com/en-us/azure/azure-signalr/signalr-concept-azure-functions |
| az-appsvc-timeout | https://learn.microsoft.com/en-us/troubleshoot/azure/app-service/web-request-times-out-app-service |
| az-aca-ingress | https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview |
| az-aca-ingress-how | https://learn.microsoft.com/en-us/azure/container-apps/ingress-how-to |
| az-aca-premium | https://learn.microsoft.com/en-us/azure/container-apps/ingress-environment-configuration and https://learn.microsoft.com/en-us/azure/container-apps/premium-ingress |
| az-aca-probes | https://learn.microsoft.com/en-us/azure/container-apps/health-probes |
| az-aci-api | https://learn.microsoft.com/en-us/rest/api/container-instances/container-groups/create-or-update |
| az-aci-trouble | https://learn.microsoft.com/en-us/azure/container-instances/container-instances-troubleshooting |
| az-aci-faq | https://learn.microsoft.com/en-us/azure/container-instances/container-instances-faq |
| az-lb-overview | https://learn.microsoft.com/en-us/azure/load-balancer/load-balancer-overview |
| az-aks-lb | https://learn.microsoft.com/en-us/azure/aks/configure-load-balancer-standard |
| az-agc-ws | https://learn.microsoft.com/en-us/azure/application-gateway/for-containers/websockets |
| az-agc-sse | https://learn.microsoft.com/en-us/azure/application-gateway/for-containers/server-sent-events |
| az-aks-approuting | https://learn.microsoft.com/en-us/azure/aks/app-routing |
| az-appsvc-cfg | https://learn.microsoft.com/en-us/azure/app-service/configure-common |
| az-appsvc-limits | https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits (App Service section) |
| az-appsvc-net | https://learn.microsoft.com/en-us/azure/app-service/networking-features |
| az-appsvc-hc | https://learn.microsoft.com/en-us/azure/app-service/monitor-instances-health-check |
| az-appsvc-snat | https://learn.microsoft.com/en-us/troubleshoot/azure/app-service/troubleshoot-intermittent-outbound-connection-errors |
| az-lb-reset | https://learn.microsoft.com/en-us/azure/load-balancer/load-balancer-tcp-reset |
| az-appgw-http | https://learn.microsoft.com/en-us/azure/application-gateway/configuration-http-settings |
| az-appgw-ws | https://learn.microsoft.com/en-us/azure/application-gateway/application-gateway-websocket |

### Cloudflare

| Key | URL |
|---|---|
| cf-protocols | https://developers.cloudflare.com/workers/reference/protocols/ |
| cf-tcp | https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ |
| cf-ws | https://developers.cloudflare.com/workers/runtime-apis/websockets/ |
| cf-do-ws | https://developers.cloudflare.com/durable-objects/best-practices/websockets/ |
| cf-net-ws | https://developers.cloudflare.com/network/websockets/ |
| cf-limits | https://developers.cloudflare.com/workers/platform/limits/ |
| cf-streams | https://developers.cloudflare.com/workers/runtime-apis/streams/ |
| cf-buffering | https://developers.cloudflare.com/changelog/post/2026-01-27-body-buffering-settings/ |
| cf-tunnel | https://developers.cloudflare.com/tunnel/troubleshooting/ |
| cf-ctr-arch | https://developers.cloudflare.com/containers/platform-details/architecture/ |
| cf-ctr-class | https://developers.cloudflare.com/containers/reference/container-class/ |
| cf-spectrum | https://developers.cloudflare.com/spectrum/ |
| cf-spectrum-plans | https://developers.cloudflare.com/spectrum/protocols-per-plan/ |
| cf-spectrum-cfg | https://developers.cloudflare.com/spectrum/reference/configuration-options/ |
| cf-spectrum-pp | https://developers.cloudflare.com/spectrum/how-to/enable-proxy-protocol/ |
| cf-spectrum-lim | https://developers.cloudflare.com/spectrum/reference/limitations/ |
| cf-conn-limits | https://developers.cloudflare.com/fundamentals/reference/connection-limits/ |
| cf-524 | https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/ |
| cf-grpc | https://developers.cloudflare.com/network/grpc-connections/ |

### PaaS and edge

| Key | URL |
|---|---|
| fly-config | https://docs.fly.io/reference/configuration/ |
| fly-services | https://docs.fly.io/networking/services/ |
| fly-udp | https://docs.fly.io/networking/udp-and-tcp/ |
| fly-hc | https://docs.fly.io/reference/health-checks/ |
| fly-autostop | https://docs.fly.io/launch/autostop-autostart/ |
| fly-h2† | https://community.fly.io/t/http-2-from-fly-proxy-to-an-app-is-now-supported-with-http-handler/16344 (Fly staff, 2023-11-08) |
| fly-tcp-idle† | https://community.fly.io/t/tcp-idle-timeouts-restrictions-have-been-removed/15160 (Fly staff, 2023-09-01) |
| railway-limits | https://docs.railway.com/networking/public-networking/specs-and-limits |
| railway-tcp | https://docs.railway.com/networking/tcp-proxy |
| railway-private | https://docs.railway.com/networking/private-networking/how-it-works |
| railway-hc | https://docs.railway.com/deployments/healthchecks |
| render-vs-vercel | https://render.com/docs/render-vs-vercel-comparison |
| render-web | https://render.com/docs/web-services |
| render-ws | https://render.com/docs/websocket |
| render-privnet | https://render.com/docs/private-network (and https://render.com/docs/private-services) |
| render-bg | https://render.com/docs/background-workers |
| render-hc | https://render.com/docs/health-checks |
| heroku-routing | https://devcenter.heroku.com/articles/http-routing |
| heroku-timeout | https://devcenter.heroku.com/articles/request-timeout |
| heroku-ws | https://devcenter.heroku.com/articles/websockets |
| heroku-container | https://devcenter.heroku.com/articles/container-registry-and-runtime |
| heroku-startup | https://devcenter.heroku.com/articles/dyno-startup-behavior |
| vercel-ws | https://vercel.com/docs/functions/websockets (last updated 2026-08-10) |
| vercel-ws-news | https://vercel.com/changelog/websocket-support-is-now-in-public-beta |
| vercel-limits | https://vercel.com/docs/functions/limitations (updated 2026-08-24) |
| vercel-stream | https://vercel.com/docs/functions/streaming-functions |
| netlify-cfg | https://docs.netlify.com/build/functions/configuration/ |
| netlify-api | https://docs.netlify.com/build/functions/api/ |
| netlify-edge | https://docs.netlify.com/build/edge-functions/limits/ |
| deno-runtime | https://docs.deno.com/deploy/reference/runtime/ |
| deno-limits | https://docs.deno.com/deploy/pricing_and_limits/ |

### Kubernetes and generic

| Key | URL |
|---|---|
| k8s-svc-proto | https://kubernetes.io/docs/reference/networking/service-protocols/ |
| k8s-svc | https://kubernetes.io/docs/concepts/services-networking/service/ |
| k8s-probes | https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/ |
| k8s-ingress | https://kubernetes.io/docs/concepts/services-networking/ingress/ |
| gw-api | https://gateway-api.sigs.k8s.io/reference/api-types/udproute/ (and the tcproute, tlsroute and grpcroute pages beside it) |
| ingress-nginx-cm | https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/configmap/ |
| ingress-nginx-misc | https://kubernetes.github.io/ingress-nginx/user-guide/miscellaneous/ |
| ingress-nginx-home | https://kubernetes.github.io/ingress-nginx/ |
| k8s-blog-retire | https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/ |
| nginx-proxy | https://nginx.org/en/docs/http/ngx_http_proxy_module.html |
| nginx-ws | https://nginx.org/en/docs/http/websocket.html |
| linux-ct | https://docs.kernel.org/networking/nf_conntrack-sysctl.html |

### Reversed-connection systems

| Key | URL |
|---|---|
| inngest-connect | https://www.inngest.com/docs/setup/connect |
| temporal-ecs† | https://temporal.io/blog/deploying-temporal-workers-to-amazon-ecs (Temporal, 2026-04-02). Temporal's docs pages `docs.temporal.io/workers` and `/cloud/security` were read and do **not** state the outbound-only property in words |
| hatchet-worker-cfg | https://docs.hatchet.run/self-hosting/worker-configuration-options (gRPC host/port, TLS, 4 MB messages). The dispatcher shape is from plan §3.8 [V-prior] |
