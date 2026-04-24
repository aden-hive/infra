// template-manager: same orchestrator binary with ORCHESTRATOR_SERVICES=template-manager
// instead of =orchestrator. It spawns a short-lived Firecracker VM per build,
// runs the provisioning + user setup script inside, snapshots memory+rootfs,
// and uploads to MinIO. API calls it over gRPC at :5020.
//
// Ports (picked to not collide with orchestrator :5007/:5008 or api :5015):
//   grpc       5020  — TemplateService
//   proxy      5021  — build-sandbox envd traffic (kept private to this host)
//
// Secrets (same set as orchestrator) at nomad/jobs/template-manager.

variable "binary" {
  type    = string
  default = "/home/ubuntu/infra/packages/orchestrator/bin/orchestrator"
}

variable "grpc_port" {
  type    = number
  default = 5020
}

variable "proxy_port" {
  type    = number
  default = 5021
}

job "template-manager" {
  type      = "service"
  node_pool = "default"
  priority  = 75

  group "template-manager" {
    count = 1

    restart {
      attempts = 3
      interval = "1m"
      delay    = "5s"
      mode     = "fail"
    }

    reschedule {
      delay          = "30s"
      delay_function = "exponential"
      max_delay      = "10m"
      unlimited      = true
    }

    network {
      port "grpc" {
        static = var.grpc_port
      }
      port "proxy" {
        static = var.proxy_port
      }
    }

    service {
      name     = "template-manager"
      port     = "grpc"
      provider = "nomad"

      check {
        type     = "tcp"
        name     = "grpc"
        interval = "10s"
        timeout  = "3s"
        port     = "grpc"
      }
    }

    task "start" {
      driver = "raw_exec"

      template {
        destination = "secrets/env"
        env         = true
        data        = <<EOT
{{ with nomadVar "nomad/jobs/template-manager" }}
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

        ENVIRONMENT           = "prod"
        ORCHESTRATOR_SERVICES = "template-manager"
        GRPC_PORT             = "${NOMAD_PORT_grpc}"
        PROXY_PORT            = "${NOMAD_PORT_proxy}"

        // Lock file — keep separate from orchestrator's /orchestrator.lock.
        ORCHESTRATOR_LOCK_PATH = "/template-manager.lock"

        // Blob storage: same MinIO + Registry config as the orchestrator.
        STORAGE_PROVIDER        = "AWSBucket"
        AWS_ENDPOINT_URL_S3     = "http://135.148.52.236:9000"
        AWS_S3_USE_PATH_STYLE   = "true"
        AWS_REGION              = "us-east-1"
        TEMPLATE_BUCKET_NAME    = "e2b-templates"
        BUILD_CACHE_BUCKET_NAME = "build-cache"

        ARTIFACTS_REGISTRY_PROVIDER     = "Registry"
        REGISTRY_DOCKER_REPOSITORY_NAME = "127.0.0.1:5000/e2b-templates"

        DOCKERHUB_REMOTE_REPOSITORY_PROVIDER = "Registry"
        DOCKERHUB_REMOTE_REPOSITORY_URL      = "127.0.0.1:5000"

        GIN_MODE          = "release"
        OTEL_SDK_DISABLED = "true"
      }

      config {
        command = "/bin/bash"
        args    = ["-c", "rm -f /template-manager.lock && exec ${var.binary}"]
      }
    }
  }
}
