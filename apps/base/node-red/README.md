# Node-RED flows and palette

Flux applies this app from `apps/staging/node-red`, which includes this directory. The running editor keeps its data on the Longhorn volume `node-red-data-longhorn` mounted at `/data`. Git holds the flow export and the palette list so a new volume can be rebuilt and so changes James makes in the editor have a reviewable history.

| Path | What it is |
| --- | --- |
| `flows/weather-flow.json` | June 3, 2023 weather flow. 65 nodes, one tab (`Flow 1`). Same export as `flows_Mac-mini.local.json`. MQTT and PostgreSQL credentials are not in the file. |
| `palette/package.json` | Palette ranges Git applies on each pod start: `node-red-dashboard@~3.6.0`, `@digitaloak/node-red-contrib-digitaloak-postgresql@~0.3.2`, and `node-red-contrib-ui-led@~0.4.11`. |
| `/data/flows.json` | Live flow. The editor writes it on every deploy. |
| `/data/flows_cred.json` | Live credentials, encrypted with `credential-secret` from the SOPS secret `node-red-admin`. This file stays on the volume. |
| `/data/package.json` and `/data/node_modules` | Palette packages actually installed, including any James has added in the editor and not yet recorded here. |

`flows/weather-flow.json` is the same file as the open backup in PR #134. This directory wires that export and the palette list into the Deployment. Staging does not keep a second copy.

## How the pod applies Git

Before Node-RED starts, init container `gitops-sync` (the same `nodered/node-red:5.0.9-24` image) runs `sync-gitops.sh` with the Git files mounted read-only at `/gitops`:

- When `/data/flows.json` is already there, it stays. Editor deploys, later tabs, and host changes on the volume survive the pod rolling.
- When `/data/flows.json` is absent (a new or emptied volume), it is seeded from Git. A single export is copied byte for byte. `flows/flows.json`, once that file exists, is the only seed; every other `flows/*.json` is still checked for secrets and then left unused. Several exports with no `flows.json` are combined. Two files that contain the same node id with different bodies stop the pod so a fresh volume is not built from an ambiguous merge.
- `flows_cred.json` is never read or written. The admin user, password hash, and credential secret stay in `apps/staging/node-red/node-red-admin-secret.yaml`.
- Each dependency in `palette/package.json` is reconciled to that Git range. The matching entry in `/data/package.json` is updated when it differs. `npm install` runs in `/data` when a listed package is missing from `/data/node_modules`, or the installed version does not satisfy the range. A version that already satisfies the range stays as it is. Packages installed from Manage palette that are not listed in Git stay in the volume's `package.json` and `node_modules`.

The ConfigMap name is hashed, so committing a flow export, `palette/package.json`, or the sync script rolls the pod. The roll uses the existing PersistentVolumeClaim. README-only edits do not roll it.

A flow export that contains a password, token, or a non-empty `credentials` object makes the init container fail. Empty `credentials: {}` objects are normal in some exports and are allowed. Version ranges in `palette/package.json` are semver ranges; a git URL or registry URL is rejected.

## When you add or change flows

1. Build the flow in the editor and deploy it. That writes `/data/flows.json` on the volume immediately. Credentials go to `/data/flows_cred.json` and are not part of the export.
2. Export from the editor menu: **Export → all flows**. A single new tab is enough when you are adding a file that does not overlap node ids with the export already in Git.
3. Save the export over `apps/base/node-red/flows/weather-flow.json` while that file is still the full flow set. When the set should stop being named for the weather flow, add the full export as `apps/base/node-red/flows/flows.json` and delete `weather-flow.json` in the same commit. `flows.json` then becomes the only seed.
4. Read the export before committing. It should be a JSON array of nodes. It should not contain broker passwords, database passwords, or a non-empty `credentials` object.
5. Commit and push. Flux refreshes the ConfigMap and recreates the pod. The volume's current `flows.json` and `flows_cred.json` stay as they are.

Check the mounted export from the running pod:

```sh
kubectl -n node-red exec deploy/node-red -c node-red -- wc -c /gitops/weather-flow.json /data/flows.json
```

### Put the Git export back onto the volume

Do this only when the volume's flow should be replaced by the committed export. Leave `flows_cred.json` where it is, and leave the `node-red-admin` secret alone. Nodes whose ids are unchanged keep their saved credentials.

```sh
kubectl -n node-red scale deploy/node-red --replicas=0
# Mount the PVC or start a one-off pod with it, then:
#   mv /data/flows.json /data/flows.json.bak
kubectl -n node-red scale deploy/node-red --replicas=1
```

The init container seeds `/data/flows.json` because the file is gone. The June 3, 2023 export still points the MQTT broker and the DigitalOak PostgreSQL connection at `localhost`, and the database name in that export is `weather data`. After a seed onto a new volume, set the broker to `mosquitto.mosquitto.svc.cluster.local` port `1883` and point PostgreSQL at the database you use in the cluster, then enter those passwords again in the editor. The live volume is expected to already have those hosts configured; a normal Git commit does not copy over that work.

## When you install a palette node

1. Install it with **Manage palette**. Node-RED updates `/data/package.json` and `/data/node_modules`. Until the package is listed in Git, restarts keep that install.
2. Record it so the next empty volume gets the same package. Read the spec the editor wrote:

   ```sh
   kubectl -n node-red exec deploy/node-red -c node-red -- cat /data/package.json
   ```

3. Add that dependency, with the same version range, to `apps/base/node-red/palette/package.json`.
4. Commit and push. On the following roll, an installed version that already satisfies the committed range is left in place.

To change a version, edit the range in `palette/package.json` and push. The next pod roll writes that range into `/data/package.json` and runs `npm install` when the copy on the volume is outside the range. Git is the desired state for every package listed there, in the same way a Deployment image tag is the desired image. An editor install of a listed package stays on the volume when that version satisfies the committed range. `npm install` replaces a version outside the range on the next roll. Removing a line from `palette/package.json` leaves the live `node_modules` copy in place. Uninstall it from Manage palette as well so a rebuilt volume and the running volume match.

The three packages recorded today are the ones the weather flow imports:

- `node-red-dashboard` supplies the `ui_*` dashboard nodes. `~3.6.0` means `>=3.6.0 <3.7.0`. A volume still on `3.4.0` is outside that range, so the next roll runs `npm install` and moves it onto a `3.6.x` release.
- `@digitaloak/node-red-contrib-digitaloak-postgresql` supplies the connection manager and query nodes. `~0.3.2` means `>=0.3.2 <0.4.0`.
- `node-red-contrib-ui-led` supplies the `ui_led` node. `~0.4.11` means `>=0.4.11 <0.5.0`.

## What stays out of Git

- `flows_cred.json`, `.config.users.json`, `.config.runtime.json`, `node_modules`, and the volume's `package-lock.json`
- The admin username, bcrypt hash, and credential secret. Update those from `apps/staging/node-red/node-red-admin-secret.example.yaml`, then encrypt with sops. The repo-root `.sops.yaml` supplies the age rule.

## Tests

```sh
sh apps/base/node-red/test-sync-gitops.sh
```

The test uses a stub `npm` and a temporary data directory. It does not talk to the cluster.
