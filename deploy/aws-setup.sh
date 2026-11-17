#!/bin/bash
# One-time setup for the AWS Learner Lab EC2 instance (Amazon Linux 2023).
# Paste it into EC2 "User data" when launching, or run it once over SSH / Instance Connect.
# Afterwards the service starts by itself whenever the instance starts, so you only press
# "Start Lab" and start the instance. When the lab stops, the instance and the service stop too.
set -e
dnf install -y docker git
systemctl enable --now docker            # docker starts at every boot
cd /opt
[ -d dist-lock-service ] || git clone https://github.com/TanmayManiyar/dist-lock-service.git
cd dist-lock-service/mini-project
docker build -t lockservice .
docker rm -f lockservice 2>/dev/null || true
# --restart unless-stopped: the container comes back automatically after each instance start
docker run -d --name lockservice --restart unless-stopped -p 80:8080 -v lockdata:/data lockservice
echo "lock service listening on :80"
