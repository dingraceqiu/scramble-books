# Scramble Books nginx ownership

`ip-location.conf` is the repository source of truth for Scramble Books routes inside the shared
exact-IP HTTP gateway. Production installs it at:

```text
/etc/nginx/project-locations/scramble-books.conf
```

`ip-gateway.conf` and `home-location.conf` are versioned recovery copies of the host-owned gateway
shell and homepage fragment. Regular application deployments must not rewrite them. Production
installs them at `/etc/nginx/sites-available/00-ip-gateway` and
`/etc/nginx/project-locations/00-home.conf`; `sites-enabled/00-ip-gateway` is a symlink. This
repository does not own the FinReport/Insight fragments or their domain configurations.

Install/update this fragment from the production checkout, then validate every route before reload:

```bash
sudo install -d -m 755 /etc/nginx/project-locations
sudo install -m 644 ops/nginx/ip-location.conf /etc/nginx/project-locations/scramble-books.conf
sudo nginx -t
sudo systemctl reload nginx
```
