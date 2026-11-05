# Node-RED weather flow

`weather-flow.json` is the June 3, 2023 export from the Mac mini's
`~/.node-red/flows_Mac-mini.local.json`. It contains 65 nodes on the `Flow 1`
tab, including the Weather Data dashboard, MQTT input, UDP input, and PostgreSQL
queries. The export contains no saved MQTT or PostgreSQL credentials.

To restore it, use **Import** in the Node-RED editor and select this file, or
replace `/data/flows.json` in the Node-RED data volume and restart the pod. Do
not replace `flows_cred.json` or change Node-RED's `credential-secret`.

The palette also needs these packages installed in `/data`:

```sh
npm install --prefix /data \
  node-red-dashboard@~3.4.0 \
  @digitaloak/node-red-contrib-digitaloak-postgresql@~0.3.2 \
  node-red-contrib-ui-led@~0.4.11
```

After importing, configure the MQTT broker and PostgreSQL connection manager
for their cluster service addresses and re-enter their credentials. The original
export points both connections at `localhost`, which is not those services when
running in the cluster.
