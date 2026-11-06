# Linux sandbox networking

Install the operator helper from the tested revision as root-owned code before
using a profile with `network: configured`:

```sh
sudo -n install -d -o root -g root -m 0755 /usr/local/lib/foundry/sandbox
sudo -n install -o root -g root -m 0755 deploy/fork/sandbox/network-policy.py /usr/local/lib/foundry/sandbox/network-policy.py
sudo -n /usr/local/lib/foundry/sandbox/network-policy.py create foundry-sandbox-runtime --subnet 172.30.240.0/24 --dns 1.1.1.1
```

Choose an unused RFC1918 subnet and configure the supervisor's network name to
match. The helper requires Python 3, Docker, nftables and iptables. Missing tools,
changed tables, absent policy state or unrecognized networks fail closed before
allocation or archive-helper startup. Its root-owned state lives in
`/var/lib/foundry-sandbox-networks`; keep that state with the host configuration.
A repeated identical create verifies the existing network without replacing it.

The dedicated interface allows public IPv4 TCP 443 and DNS to the selected public
resolver. OCI container creation pins that resolver explicitly; Docker's embedded
DNS may forward queries from the daemon, so DNS is a separate trusted path, not
proof that every packet passes through the bridge. Private, loopback, link-local,
CGNAT, reserved and multicast destinations are denied. Host input, unsolicited
inbound connections, same-bridge peers and all IPv6 traffic are denied. A separate
bridge-family table enforces peer isolation without changing global bridge
netfilter sysctls. Other interfaces and existing firewall policies are preserved.

For a private Main endpoint, explicitly add `--control IPv4:port` when creating
the network. This authorizes only that destination TCP endpoint and installs exact
interface-scoped INPUT/FORWARD exceptions so existing host firewall or Docker
isolation does not silently block it. Public Main HTTPS needs no exception. The
exception does not remove application authentication. Do not authorize a Docker
API, database or general proxy as the control endpoint.

Public HTTPS is an IP/port policy, not a domain allowlist: arbitrary public HTTPS
servers and shared CDN addresses are reachable. DNS tunneling, HTTPS exfiltration,
the authorized Main endpoint and the common host kernel remain isolation limits.
These containers are not a separate VM or a boundary against a compromised host
administrator. No host Docker socket, privileged mode or global host mount is
needed inside the sandbox.

Inspect or remove an empty network using the same installed helper:

```sh
sudo -n /usr/local/lib/foundry/sandbox/network-policy.py inspect foundry-sandbox-runtime
sudo -n /usr/local/lib/foundry/sandbox/network-policy.py remove foundry-sandbox-runtime
```

Removal refuses attached containers. It deletes only the recorded network, its
own nftables tables and exact control exceptions. It never flushes global rules.
Missing or changed rules require operator investigation; the helper does not
silently repair policy while workloads are attached. Host reboot does not persist
these nftables tables automatically. Keep sandbox containers on `restart=no` and
restore reviewed host network configuration before restarting allocations; an
absent policy causes supervisor provisioning to fail rather than run unrestricted.

Run the real acceptance against an existing immutable image containing Node:

```sh
sudo -n python3 deploy/fork/sandbox/test-network-policy.py --image '<repository>@sha256:<digest>'
```

It uses its own bridges in `172.30.241.0/28` and `172.30.242.0/28`, verifies actual
peer/host/private/metadata blocking, an exact control exception, public GitHub and
unauthenticated OpenAI HTTPS, policy drift rejection and cleanup. Occupied fixture
subnets cause refusal. It starts no agent turn and sends no provider credentials.

## Package installation and archives

Sandbox setup and runtime set `npm_config_package_import_method=copy` and
`pnpm_config_package_import_method=copy` (required by pnpm 12) so supported
pnpm/vp installs materialize independent files instead of hardlinking the package
store into the workspace. Profiles using another installer must configure copying
or reflinks (distinct inodes), including for their dependency caches. An installer
CLI flag or project configuration that explicitly overrides the environment can
still create hardlinks; such profiles are not archive-ready.

The snapshot guard intentionally rejects files whose link count is not one. It
protects against archiving another allocation or private runtime file through a
hardlink. Explicitly created hardlinks still block archive confirmation and keep
the environment retained; the copy setting does not weaken that check or rewrite
existing links. Correct the profile before allocation and verify its actual
installer output before relying on automatic archive/delete.
