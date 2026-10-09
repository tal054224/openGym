# Caddy without its file capability. Listening on 8080/8443 needs no privileged-port bind, and
# the stock binary's cap_net_bind_service file capability makes it refuse to start once every
# capability is dropped (cap_drop: [ALL]) — which is how this stack runs it.
FROM caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
RUN setcap -r /usr/bin/caddy
