# Distributed Lock Service Virtual Lab

A static, server-free virtual lab with six experiments (leases, leader election, log replication, partitions, fencing tokens, crash recovery),
each with Aim, Theory, Pretest, Procedure, Simulation, Posttest, References and Feedback.

The lock cluster in the Simulation tab is a **simulation that runs entirely in the visitor's browser** (`sim.js`: the same Raft and lock logic
as the Mini Project, with an in-memory network and disks). Each visitor gets a private cluster and nothing is sent to a server.
This folder is independent of the Mini Project and shares no code with it.

## Run locally

```bash
npm start          # serves this folder at http://localhost:8099
```

(or any static server, for example `python -m http.server 8099`). Open http://localhost:8099 and it goes straight to the lab.

## Deploy (Vercel)

```bash
npx vercel deploy --prod
```

run inside this folder, or import the repository in Vercel and set the **Root Directory** to `vlab`. There is no build step.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Redirects to `/lab/` |
| `lab/` | Lab home, the experiment pages (`experiment.html`, `exp1.js` to `exp6.js`) and the lab shell (`lab.js`, `lab.css`) |
| `panel.html`, `panel.js`, `panel.css` | The live-system panel shown inside each Simulation tab |
| `sim.js` | The in-browser simulation of the 5-replica cluster |
| `ui.css` | Shared styles |
| `vercel.json` | Static hosting settings |
| `VIRTUAL_LAB_PLAN.md` | Design notes for the lab |
