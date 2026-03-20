/**
 * Test workspace configuration and paths
 */

export const TEST_WORKSPACE = {
  root: process.env.TEST_WORKSPACE_ROOT || "/local/mnt/workspace/code1/WLAN.CNG.1.0-01880.3-QCACNGSWPL_V1_V2_SILICON-1",
  clangdBin: process.env.TEST_CLANGD_BIN || "/usr/local/bin/clangd-20",
  
  // Known test files in the workspace
  files: {
    wlanThread: "wlan_thread.c",
    bpfOffload: "wlan_proc/wlan/fw/target/protocol/src/offloads/src/l2/bpf/bpf_offload.c",
  },
  
  // Known symbols for content validation
  symbols: {
    functions: ["wlan_bpf_filter_offload_handler", "wlan_bpf_offload_pdev_init"],
    types: ["wlan_pdev_t", "wlan_vdev_t"],
  },
}

export const TEST_PORTS = {
  httpDaemon: 7777,
  httpStandalone: 8888,
}
EOF
