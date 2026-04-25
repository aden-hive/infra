// api: REST lifecycle service on :3000 + gRPC :5009 for internal callers.
// Creates sandboxes via orchestrator gRPC, writes them to the sandbox catalog
// so client-proxy can route cross-host.
//
// Auth model for OVH self-host:
//   JWT_SECRETS — plain HS256 secret(s) used to verify incoming bearer JWTs
//     (the env var was historically SUPABASE_JWT_SECRETS, since renamed).
//     hive-backend's Passport-JWT signer signs with the same secret.
//   ADMIN_TOKEN — service-to-service bearer for admin endpoints (POST
//     /sandboxes/admin/..., etc). Good enough for PoC without wiring JWTs.
//
// Loki / ClickHouse: the constructors don't do startup RPCs, so LOKI_URL can
// point at an unreachable address; calls only fire on /logs endpoints we
// don't exercise today.

variable "api_binary" {
  type    = string
  default = "/home/ubuntu/infra/packages/api/bin/api"
}

variable "port" {
  type    = number
  default = 3000
}

// 5009 collides with client-proxy health; pick an unused port.
variable "grpc_port" {
  type    = number
  default = 5015
}

job "api" {
  node_pool = "default"
  priority  = 90

  group "api-service" {
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
      port "api" {
        static = var.port
      }
      port "grpc" {
        static = var.grpc_port
      }
    }

    service {
      name     = "api"
      port     = "api"
      provider = "nomad"

      check {
        type     = "http"
        name     = "health"
        path     = "/health"
        interval = "5s"
        timeout  = "3s"
        port     = "api"
      }
    }

    service {
      name     = "api-grpc"
      port     = "grpc"
      provider = "nomad"

      check {
        type     = "tcp"
        name     = "grpc"
        interval = "5s"
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
{{ with nomadVar "nomad/jobs/api" }}
POSTGRES_CONNECTION_STRING={{ .POSTGRES_CONNECTION_STRING }}
REDIS_URL={{ .REDIS_URL }}
NOMAD_TOKEN={{ .NOMAD_TOKEN }}
ADMIN_TOKEN={{ .ADMIN_TOKEN }}
JWT_SECRETS={{ .JWT_SECRETS }}
SANDBOX_ACCESS_TOKEN_HASH_SEED={{ .SANDBOX_ACCESS_TOKEN_HASH_SEED }}
VOLUME_TOKEN_SIGNING_KEY={{ .VOLUME_TOKEN_SIGNING_KEY }}
{{ end }}
EOT
      }

      env {
        NODE_ID     = "${node.unique.name}"

        API_GRPC_PORT = "${NOMAD_PORT_grpc}"
        DOMAIN_NAME   = "135.148.52.236"
        ENVIRONMENT   = "prod"

        NOMAD_ADDRESS = "http://127.0.0.1:4646"

        // Volume tokens: HMAC signing via env-provided key.
        VOLUME_TOKEN_ISSUER          = "e2b-ovh"
        VOLUME_TOKEN_SIGNING_METHOD  = "HS256"
        VOLUME_TOKEN_SIGNING_KEY_NAME = "ovh-1"

        // Loki: URL is required by env parser but not called at startup.
        LOKI_URL = "http://127.0.0.1:9999"

        // Empty ClickHouse string disables analytics writes.
        CLICKHOUSE_CONNECTION_STRING = ""

        // Sandbox catalog storage: memory with Redis shadow write (so
        // client-proxy can read from Redis without losing in-process speed).
        SANDBOX_STORAGE_BACKEND = "memory"

        // See orchestrator.hcl — TEMPLATE_BUCKET_NAME is required by a
        // transitively imported package but not used by API.
        TEMPLATE_BUCKET_NAME = "skip"

        OTEL_SDK_DISABLED = "true"
        GIN_MODE          = "release"
      }

      config {
        command = "/bin/bash"
        args    = ["-c", "exec ${var.api_binary} --port ${var.port}"]
      }
    }
  }
}
