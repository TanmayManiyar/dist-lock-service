# Distributed Lock Service

Two independent projects live in this repository. They share no code and no server, and each one can be moved, run and deployed on its own.

| Folder | What it is | How it runs |
|---|---|---|
| [`mini-project/`](mini-project/) | The real **fault-tolerant distributed lock service**: Raft consensus on 5 replica processes, leases, fencing tokens, a gateway, a dashboard frontend with a live backend terminal, tests and benchmarks | Locally on your own machine: `cd mini-project && npm run fresh`, then open http://localhost:8080 |
| [`vlab/`](vlab/) | The **Virtual Lab**: six experiments with theory, quizzes and a guided simulation. The lock cluster inside it is an in-browser simulation | A static website. Locally: `cd vlab && npm start`. Deployed on Vercel from this folder only |

Start with [`mini-project/README.md`](mini-project/README.md) for the project and how to present it, and [`vlab/README.md`](vlab/README.md) for the lab.
