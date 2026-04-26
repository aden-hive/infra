package cfg

import "github.com/caarlos0/env/v11"

type Config struct {
	HealthPort uint16 `env:"HEALTH_PORT" envDefault:"3003"`
	ProxyPort  uint16 `env:"PROXY_PORT"  envDefault:"3002"`

	RedisURL         string `env:"REDIS_URL"`
	RedisClusterURL  string `env:"REDIS_CLUSTER_URL"`
	RedisTLSCABase64 string `env:"REDIS_TLS_CA_BASE64"`
	RedisPoolSize    int    `env:"REDIS_POOL_SIZE"     envDefault:"40"`

	ApiGrpcAddress string `env:"API_GRPC_ADDRESS"`

	// HS256 secret used by hive-backend to sign embed tokens for the
	// noVNC iframe and websockify upgrade. Empty disables verification
	// (e.g. local dev). Must match hive-backend's E2B_EMBED_TOKEN_SECRET.
	EmbedTokenSecret string `env:"EMBED_TOKEN_SECRET"`
}

func Parse() (Config, error) {
	return env.ParseAsWithOptions[Config](env.Options{})
}
