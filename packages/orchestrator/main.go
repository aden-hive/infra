package main

import (
	"context"

	"github.com/e2b-dev/infra/packages/orchestrator/pkg/factories"
	"github.com/e2b-dev/infra/packages/orchestrator/pkg/sandbox/network"
)

const version = "0.1.0"

var commitSHA string

func main() {
	factories.Run(factories.Options{
		Version:       version,
		CommitSHA:     commitSHA,
		EgressFactory: noopEgressFactory,
	})
}

// Egress firewall disabled — sandboxes get direct internet via the
// MASQUERADE rule installed in network.go. The TCP firewall proxy
// (tcpfirewall.New) intercepts every port-80/443/other from each veth
// and forwards through an allowlist proxy on host:5016/5017/5018, but
// we don't need that gate for our use case (one-tenant OVH host).
func noopEgressFactory(_ context.Context, _ *factories.Deps) (*factories.EgressSetup, error) {
	return &factories.EgressSetup{Proxy: network.NewNoopEgressProxy()}, nil
}
