# Hybrid deployment: Vercel link + AWS Learner Lab backend

One public Vercel link. If your AWS lab is running, it opens the **real Raft cluster**. If the lab is
stopped, the same link shows the same dashboard running on a built-in simulation in the browser.

```
Browser --> Vercel (static pages + /api proxy) --> AWS EC2 :80 (gateway + 5 replicas)
                     \--> if AWS does not answer within ~5 s --> built-in simulator (sim-backend.js)
```

Why a proxy: Vercel pages are HTTPS but the EC2 gateway is plain HTTP. Browsers block that mix, so the
browser only ever talks to Vercel, and the function `api/[...path].js` calls EC2 server to server.

## 1. AWS side (once per lab account)
1. AWS Academy -> **Start Lab** -> open the console.
2. EC2 -> Launch instance: Amazon Linux 2023, **t3.small**, security group with inbound **HTTP (port 80)**
   from anywhere (and SSH 22 if you want it).
3. Under *Advanced details -> User data* paste `deploy/aws-setup.sh`. (Or run it once by hand.)
4. EC2 -> Elastic IPs -> allocate one and associate it with the instance. This keeps the address fixed
   across lab restarts. Without it the address changes every time and you would have to change the
   Vercel variable each session.
5. Check `http://<elastic-ip>` shows the dashboard.

## 2. Vercel side (once)
1. vercel.com/new -> import `TanmayManiyar/dist-lock-service`. Leave **Root Directory** empty (repo
   root). `vercel.json` already sets the build command and output folder.
2. Settings -> Environment Variables:
   - `BACKEND_URL` = `http://<elastic-ip>`
   - optional `BACKEND_AUTH` = `user:password` (only if you run the gateway with `BASIC_AUTH`)
3. Deploy. That URL is the link you give to teachers.

## 3. Every day you demo
1. AWS Academy -> **Start Lab**.
2. EC2 -> Instances -> **Start instance** (wait about 1 minute for the gateway to come up).
3. Open the Vercel link. It shows "Live Raft cluster on AWS".
4. When you press **End Lab** / the session ends, the instance stops and the link falls back to the simulation
   automatically. Nothing to change.

The banner at the bottom of the page says SIMULATED MODE when the AWS cluster is offline; its
"Retry live cluster" button re-checks.

## Limits and notes
- Learner Lab budgets and rules differ by course; an Elastic IP that is not attached to a running
  instance can cost a little credit.
- Each dashboard poll is one Vercel function call (about 2 per second per open viewer). Fine for a
  demo; the free Vercel plan has monthly limits, so do not leave many tabs open.
- The AWS instance was launched and tested directly (leader elected, lock acquire and refusal). The
  Vercel proxy and the simulation fallback were tested locally.
- Anyone with the link can crash replicas and run the chaos buttons on the live cluster.
