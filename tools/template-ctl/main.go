// template-ctl is a minimal gRPC client for the template-manager
// TemplateService. Used to submit template build requests from outside the
// API service (e.g. during single-host PoC verification).
//
//	template-ctl build -template hivev3 -build <uuid> -fromImage 127.0.0.1:5000/hive-novnc:systemd
//	template-ctl status -template hivev3 -build <uuid>
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

	tmplmgr "github.com/e2b-dev/infra/packages/shared/pkg/grpc/template-manager"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: template-ctl {build|status} [flags]")
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:5020", "template-manager gRPC address")

	switch cmd {
	case "build":
		tmpl := fs.String("template", "", "template id (required)")
		build := fs.String("build", "", "build id (UUID, required)")
		fromImage := fs.String("fromImage", "127.0.0.1:5000/hive-novnc:systemd", "base OCI image")
		kernel := fs.String("kernel", "vmlinux-6.1.158", "kernel version")
		fc := fs.String("fc", "v1.12.1_210cbac", "firecracker version")
		vcpu := fs.Int("vcpu", 2, "vCPUs")
		memMB := fs.Int("memory", 2560, "memory MB")
		diskMB := fs.Int("disk", 6144, "disk MB")
		hugepages := fs.Bool("hugepages", false, "use hugepages")
		startCmd := fs.String("start-cmd", "", "start command (run inside sandbox)")
		teamID := fs.String("team", "00000000-0000-0000-0000-000000000000", "team id")
		_ = fs.Parse(os.Args[2:])
		if *tmpl == "" || *build == "" {
			log.Fatal("-template and -build required")
		}

		conn := dial(*addr)
		defer conn.Close()
		client := tmplmgr.NewTemplateServiceClient(conn)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		defer cancel()

		cfg := &tmplmgr.TemplateConfig{
			TemplateID:         *tmpl,
			BuildID:            *build,
			MemoryMB:           int32(*memMB),
			VCpuCount:          int32(*vcpu),
			DiskSizeMB:         int32(*diskMB),
			KernelVersion:      *kernel,
			FirecrackerVersion: *fc,
			HugePages:          *hugepages,
			StartCommand:       *startCmd,
			TeamID:             *teamID,
			Source:             &tmplmgr.TemplateConfig_FromImage{FromImage: *fromImage},
		}
		_, err := client.TemplateCreate(ctx, &tmplmgr.TemplateCreateRequest{Template: cfg})
		if err != nil {
			log.Fatalf("TemplateCreate: %v", err)
		}
		fmt.Println("submitted")

	case "status":
		tmpl := fs.String("template", "", "template id (required)")
		build := fs.String("build", "", "build id (required)")
		follow := fs.Bool("follow", false, "follow logs")
		_ = fs.Parse(os.Args[2:])
		if *tmpl == "" || *build == "" {
			log.Fatal("-template and -build required")
		}

		conn := dial(*addr)
		defer conn.Close()
		client := tmplmgr.NewTemplateServiceClient(conn)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()

		for {
			resp, err := client.TemplateBuildStatus(ctx, &tmplmgr.TemplateStatusRequest{
				TemplateID: *tmpl,
				BuildID:    *build,
			})
			if err != nil {
				log.Fatalf("TemplateBuildStatus: %v", err)
			}
			fmt.Printf("status=%s\n", resp.String())
			if !*follow {
				return
			}
			time.Sleep(3 * time.Second)
		}

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
