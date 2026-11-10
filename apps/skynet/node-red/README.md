# Node-RED on skynet

Flux Kustomization `apps` (`clusters/skynet/apps.yaml`) builds this directory. It sets namespace `node-red` and includes:

- `apps/base/node-red` — Deployment, Service, Longhorn PVC, settings, the weather flow export, and `palette/package.json`
- `ingress.yaml` — `nodered.jameshomelab.org`
- `node-red-admin-secret.yaml` — SOPS-encrypted admin user, password hash, and credential secret

The flow export and the palette list live only in the base directory. This overlay does not carry a second copy, so the two cannot drift. Editor credentials stay in that SOPS secret and in `flows_cred.json` on the Longhorn volume.

Anonymous visitors can open the Weather Data dashboard and see the graphs. They cannot send dashboard widget input or call an HTTP In route. Both checks reuse the admin user and hash in `node-red-admin`. The pod copies a committed flow onto `/data/flows.json` only when that file is missing, so a flow edit in Git does not by itself replace the live switch. The base README has the visitor rules and the update steps.

Day-to-day steps for exporting a flow and recording a palette package are in [apps/base/node-red/README.md](../../base/node-red/README.md).

To change the admin secret, copy `node-red-admin-secret.example.yaml`, fill in the new values, and encrypt with sops before committing. The example file is not applied.
