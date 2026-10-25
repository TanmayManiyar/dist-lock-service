# Deployment: running the lock service on real VMs in a VPC

The system has three kinds of processes:

| Process | Count | Command | Network |
|---|---|---|---|
| **Replica** | 5 (one per VM) | `node node.js <id> 5 /var/lib/lock` | private subnet, peers talk on `:7001` |
| **Gateway** | 1 or more | `node server.js` (with `REMOTE_NODES`) | public via load balancer, `:8080` |
| **Clients / dashboard** | any | HTTP to the gateway | internet |

The same code runs locally (replicas are child processes), in Docker (section 1) and on cloud VMs (section 2). The only difference is how replicas find each other:

| Variable | Used by | Meaning |
|---|---|---|
| `NODE_ADDRS` | replica | `1=host:port,2=host:port,...` addresses of **all** replicas, including itself (its own entry gives the port to listen on) |
| `NODE_HOST` | replica | interface to bind (`0.0.0.0` on VMs/containers) |
| `DURABLE=1` | replica | `fsync` every write (production setting) |
| `REMOTE_NODES` | gateway | same list; switches the gateway to remote mode (fault injection uses each replica's admin API: crash / start / wipe) |
| `BASIC_AUTH=user:pass` | gateway | require HTTP basic auth for the dashboard and every API |
| `DATA_DIR`, `PORT`, `BASE_PORT` | both | data directory, gateway port, local replica base port |

## 1. Docker Compose (quickest "VPC")

```bash
docker compose up --build
# dashboard http://localhost:8080
```

Five replica containers and a gateway share a private bridge network; only the gateway publishes a port. Each replica has a named volume (its disk), so `docker compose restart node3` is a real process restart that reloads term, vote and log from disk. Set `BASIC_AUTH=user:password` in the environment to password-protect the dashboard.

## 2. AWS (EC2 + VPC)

Mapping to the assignment's primitives: **Cloud VM cluster** = 5 EC2 instances; **VPC** = private subnets, security groups and a load balancer; **disk** = EBS volumes.

### 2.1 Network

1. Create a VPC `10.0.0.0/16` with **three private subnets** in different Availability Zones (a, b, c) and one public subnet (gateway / load balancer).
2. Security groups:
   * `sg-replica`: inbound **TCP 7001 from `sg-replica` and `sg-gateway` only**; no internet inbound; SSH only from a bastion or SSM.
   * `sg-gateway`: inbound TCP 8080 from the load balancer (or your IP range); outbound to `sg-replica:7001`.
3. Spread replicas over the AZs: N1, N4 in a; N2, N5 in b; N3 in c. Losing one AZ then costs at most 2 of 5 replicas and the cluster keeps its quorum.

### 2.2 Replicas (5 x EC2, e.g. `t3.small`, Amazon Linux 2023)

On each VM (user-data or manually):

```bash
sudo dnf install -y nodejs git
sudo useradd -r lock && sudo mkdir -p /opt/lock /var/lib/lock && sudo chown lock /var/lib/lock
sudo cp node.js package.json /opt/lock/        # from this repository
```

Attach a dedicated EBS volume mounted at `/var/lib/lock` (gp3). Create `/etc/lock-node.env`:

```
NODE_HOST=0.0.0.0
DURABLE=1
NODE_ADDRS=1=10.0.1.11:7001,2=10.0.2.12:7001,3=10.0.3.13:7001,4=10.0.1.14:7001,5=10.0.2.15:7001
```

and a systemd unit `/etc/systemd/system/lock-node.service` (set `ID` per host):

```
[Unit]
Description=Lock service replica
After=network-online.target

[Service]
User=lock
EnvironmentFile=/etc/lock-node.env
ExecStart=/usr/bin/node /opt/lock/node.js ID 5 /var/lib/lock
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now lock-node
```

`Restart=always` gives a real crash-restart loop: kill the process and it comes back, reading its state from the EBS volume.

### 2.3 Gateway (1-2 x EC2 or a container, public subnet)

```bash
export REMOTE_NODES="1=10.0.1.11:7001,2=10.0.2.12:7001,3=10.0.3.13:7001,4=10.0.1.14:7001,5=10.0.2.15:7001"
export BASIC_AUTH="lab:choose-a-password"
node server.js        # needs package.json, server.js, public/
```

Put an Application/Network Load Balancer in front (HTTPS with an ACM certificate) and forward to `:8080`. The gateway is stateless apart from the demo "protected resource", so more than one can run behind the load balancer for the lock API; use one for the dashboard (the demo resource lives in its memory).

### 2.4 Verify

```bash
curl -u lab:pass https://<lb-dns>/api/cluster      # five nodes up, one leader
node test.js   # edit B to the public URL, or follow the dashboard steps in the browser
```

Fault injection works in remote mode through the replicas' admin API (`/admin/crash`, `/admin/start`, `/admin/wipe`); for infrastructure-level faults, also try `sudo systemctl stop lock-node`, `aws ec2 stop-instances`, or security-group edits to create **real** network partitions.

## 3. Hosting the dashboard publicly

The dashboard needs the running gateway and cluster. Options: a single small VM running Docker Compose (simplest, about the cost of one `t3.small` or equivalent on Render/Railway/Fly.io), or the AWS layout above. **Always set `BASIC_AUTH`** (or restrict by IP): the dashboard exposes crash and wipe controls.

## 4. Security and limitations

* The replica API (`/raft/*`, `/client/*`, `/admin/*`) has **no authentication** and no TLS. It must only be reachable from the replica and gateway security groups. For production, add mutual TLS between replicas and an authenticated client API.
* `DURABLE=1` makes writes survive power loss; without it only a process crash is tolerated.
* The wipe operation (demo only) is unsafe in real Raft clusters; treat a replaced disk as a new member (no membership changes are implemented).
* Lease expiry assumes loosely synchronised clocks (use chrony / Amazon Time Sync).
* **Tested:** section 1 (Docker Compose: gateway in remote mode, kill / restart / wipe through the admin API, `docker compose restart` of all five replicas with the lock surviving, and basic auth). **Not tested:** section 2 (AWS) was written from the design and has not been run against a real AWS account.
