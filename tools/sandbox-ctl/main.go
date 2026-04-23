// sandbox-ctl is a minimal gRPC client for the orchestrator SandboxService.
// Intended for single-host PoC verification — not a long-lived CLI.
//
//	sandbox-ctl create -id <short-id> -template <uuid> -build <uuid>
//	sandbox-ctl list
//	sandbox-ctl delete -id <short-id>
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	orch "github.com/e2b-dev/infra/packages/shared/pkg/grpc/orchestrator"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: sandbox-ctl {create|list|delete} [flags]")
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:5008", "orchestrator gRPC address")

	switch cmd {
	case "create":
		id := fs.String("id", "", "sandbox id (lowercase alphanumeric, required)")
		tmpl := fs.String("template", "", "template id (required)")
		build := fs.String("build", "", "build id (required)")
		kernel := fs.String("kernel", "6.1.158", "kernel version")
		fc := fs.String("fc", "v1.13.0", "firecracker version")
		vcpu := fs.Int64("vcpu", 2, "vCPUs")
		ramMB := fs.Int64("ram", 2560, "RAM MB")
		diskMB := fs.Int64("disk", 6144, "disk MB")
		hugepages := fs.Bool("hugepages", false, "use hugepages")
		alias := fs.String("alias", "", "optional alias")
		_ = fs.Parse(os.Args[2:])
		if *id == "" || *tmpl == "" || *build == "" {
			log.Fatal("-id, -template, -build all required")
		}
		conn := dial(*addr)
		defer conn.Close()
		client := orch.NewSandboxServiceClient(conn)
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		cfg := &orch.SandboxConfig{
			TemplateId:         *tmpl,
			BuildId:            *build,
			KernelVersion:      *kernel,
			FirecrackerVersion: *fc,
			HugePages:          *hugepages,
			SandboxId:          *id,
			Vcpu:               *vcpu,
			RamMb:              *ramMB,
			TotalDiskSizeMb:    *diskMB,
			MaxSandboxLength:   24,
			EnvdVersion:        "0.1.0",
			TeamId:             "00000000-0000-0000-0000-000000000000",
		}
		if *alias != "" {
			cfg.Alias = alias
		}
		req := &orch.SandboxCreateRequest{
			Sandbox:   cfg,
			StartTime: timestamppb.Now(),
			EndTime:   timestamppb.New(time.Now().Add(1 * time.Hour)),
		}
		resp, err := client.Create(ctx, req)
		if err != nil {
			log.Fatalf("Create: %v", err)
		}
		fmt.Printf("created sandbox %s (client %s)\n", *id, resp.ClientId)

	case "list":
		_ = fs.Parse(os.Args[2:])
		conn := dial(*addr)
		defer conn.Close()
		client := orch.NewSandboxServiceClient(conn)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		resp, err := client.List(ctx, &emptypb.Empty{})
		if err != nil {
			log.Fatalf("List: %v", err)
		}
		for _, s := range resp.Sandboxes {
			fmt.Printf("%s  template=%s  client=%s  start=%s\n", s.Config.SandboxId, s.Config.TemplateId, s.ClientId, s.StartTime.AsTime().Format(time.RFC3339))
		}
		fmt.Printf("total: %d\n", len(resp.Sandboxes))

	case "delete":
		id := fs.String("id", "", "sandbox id")
		_ = fs.Parse(os.Args[2:])
		if *id == "" {
			log.Fatal("-id required")
		}
		conn := dial(*addr)
		defer conn.Close()
		client := orch.NewSandboxServiceClient(conn)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err := client.Delete(ctx, &orch.SandboxDeleteRequest{SandboxId: *id})
		if err != nil {
			log.Fatalf("Delete: %v", err)
		}
		fmt.Printf("deleted %s\n", *id)

	default:
		log.Fatalf("unknown command: %s", cmd)
	}
}

func dial(addr string) *grpc.ClientConn {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("dial %s: %v", addr, err)
	}
	return conn
}
