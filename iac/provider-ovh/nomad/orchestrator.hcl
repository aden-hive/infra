// orchestrator: runs one Firecracker-managing agent per bare-metal node.
// System job → Nomad places one allocation per eligible client automatically.
// Registers `orchestrator` (gRPC) and `orchestrator-proxy` (HTTP) in Nomad service discovery.
//
// Env flips vs the prior single-node systemd unit:
//   STORAGE_PROVIDER            Local            → AWSBucket (against local MinIO via AWS_ENDPOINT_URL_S3)
//   ENVIRONMENT                 local            → prod      (IsDevelopment()=false → NewStorageKV for network slots)
//   NODE_ID                     ovh-vinthill-1   → ${node.unique.name}
//   REDIS_URL                   127.0.0.1:6379   → redis://default:PASS@127.0.0.1:6379
//   ARTIFACTS_REGISTRY_PROVIDER (unset)          → Registry  (local registry:2 → MinIO oci-registry bucket)
//   DOCKERHUB_..._PROVIDER      (unset)          → Registry
//   USE_LOCAL_NAMESPACE_STORAGE true             → removed   (use Consul-KV-backed StorageKV)
//
// Secrets (POSTGRES/MINIO/REDIS/CONSUL) come from Nomad variables at path
// `ovh/e2b/orchestrator`; seeded via `nomad var put ovh/e2b/orchestrator @env.json`.

variable "orchestrator_version" {
  type    = string
  default = "dev"
}

variable "orchestrator_binary" {
  type    = string
  default = "/home/ubuntu/infra/packages/orchestrator/bin/orchestrator"
}

variable "grpc_port" {
  type    = number
  default = 5008
}

variable "proxy_port" {
  type    = number
  default = 5007
}

job "orchestrator" {
  type      = "system"
  node_pool = "default"
  priority  = 91

  group "client-orchestrator" {
    network {
      port "grpc" {
        static = var.grpc_port
      }
      port "proxy" {
        static = var.proxy_port
      }
    }

    service {
      name     = "orchestrator"
      port     = "grpc"
      provider = "nomad"

      check {
        type     = "http"
        path     = "/health"
        name     = "health"
        interval = "20s"
        timeout  = "5s"
      }
    }

    service {
      name     = "orchestrator-proxy"
      port     = "proxy"
      provider = "nomad"

      check {
        type     = "tcp"
        name     = "health"
        interval = "30s"
        timeout  = "1s"
      }
    }

    task "start" {
      driver = "raw_exec"

      restart {
        attempts = 3
        interval = "1m"
        delay    = "5s"
        mode     = "fail"
      }

      // Required secrets, stored at nomad/jobs/orchestrator (auto-readable via
      // task workload identity — no ACL policy needed).
      //   sudo nomad var put nomad/jobs/orchestrator \
      //       MINIO_ACCESS=... MINIO_SECRET=... REDIS_URL=... CONSUL_TOKEN=...
      template {
        destination = "secrets/env"
        env         = true
        data        = <<EOT
{{ with nomadVar "nomad/jobs/orchestrator" }}
AWS_ACCESS_KEY_ID={{ .MINIO_ACCESS }}
AWS_SECRET_ACCESS_KEY={{ .MINIO_SECRET }}
REDIS_URL={{ .REDIS_URL }}
CONSUL_TOKEN={{ .CONSUL_TOKEN }}
{{ end }}
EOT
      }

      env {
        NODE_ID = "${node.unique.name}"
        NODE_IP = "${attr.unique.network.ip-address}"

        ENVIRONMENT            = "prod"
        GRPC_PORT              = "${NOMAD_PORT_grpc}"
        PROXY_PORT             = "${NOMAD_PORT_proxy}"
        ORCHESTRATOR_SERVICES  = "orchestrator"
        OTEL_SDK_DISABLED      = "true"
        GIN_MODE               = "release"
        PROVIDER               = "ovh"

        // Blob storage: MinIO via S3 API
        STORAGE_PROVIDER          = "AWSBucket"
        AWS_ENDPOINT_URL_S3       = "http://135.148.52.236:9000"
        AWS_S3_USE_PATH_STYLE     = "true"
        AWS_REGION                = "us-east-1"
        TEMPLATE_BUCKET_NAME      = "e2b-templates"
        BUILD_CACHE_BUCKET_NAME   = "build-cache"

        // Artifacts registry: registry:2 on loopback, backed by MinIO
        ARTIFACTS_REGISTRY_PROVIDER      = "Registry"
        REGISTRY_DOCKER_REPOSITORY_NAME  = "127.0.0.1:5000/e2b-templates"

        // Dockerhub source resolution: same registry:2
        DOCKERHUB_REMOTE_REPOSITORY_PROVIDER = "Registry"
        DOCKERHUB_REMOTE_REPOSITORY_URL      = "127.0.0.1:5000"
      }

      config {
        command = "/bin/bash"
        args    = ["-c", "rm -f /orchestrator.lock && exec ${var.orchestrator_binary}"]
      }
    }
  }
}
