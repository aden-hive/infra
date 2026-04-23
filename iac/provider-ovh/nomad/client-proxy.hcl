// client-proxy: edge service that resolves sandbox_id → orchestrator host via
// Redis catalog and reverse-proxies to orchestrator :5007 on the right node.
// Replaces "curl ... orchestrator:5007" as the public entrypoint once multiple
// orchestrators exist. Runs as a service job so Nomad can place it on any
// `api` pool node (today: just host-1 self-hosting).

variable "client_proxy_binary" {
  type    = string
  default = "/home/ubuntu/infra/packages/client-proxy/bin/client-proxy"
}

variable "proxy_port" {
  type    = number
  default = 5006
}

variable "health_port" {
  type    = number
  default = 5009
}

job "client-proxy" {
  node_pool = "default"
  priority  = 80

  group "client-proxy" {
    count = 1

    restart {
      attempts = 2
      interval = "10m"
      delay    = "10s"
      mode     = "fail"
    }

    reschedule {
      delay          = "30s"
      delay_function = "exponential"
      max_delay      = "10m"
      unlimited      = true
    }

    network {
      port "proxy" {
        static = var.proxy_port
      }
      port "health" {
        static = var.health_port
      }
    }

    service {
      name     = "client-proxy"
      port     = "proxy"
      provider = "nomad"

      check {
        type     = "http"
        name     = "health"
        path     = "/health"
        interval = "5s"
        timeout  = "3s"
        port     = "health"
      }
    }

    task "start" {
      driver = "raw_exec"

      template {
        destination = "secrets/env"
        env         = true
        data        = <<EOT
{{ with nomadVar "nomad/jobs/client-proxy" }}
REDIS_URL={{ .REDIS_URL }}
{{ end }}
EOT
      }

      env {
        NODE_ID     = "${node.unique.name}"
        NODE_IP     = "${attr.unique.network.ip-address}"

        HEALTH_PORT = "${NOMAD_PORT_health}"
        PROXY_PORT  = "${NOMAD_PORT_proxy}"
        ENVIRONMENT = "prod"

        OTEL_SDK_DISABLED = "true"
      }

      config {
        command = "/bin/bash"
        args    = ["-c", "exec ${var.client_proxy_binary}"]
      }
    }
  }
}
