package main

import (
	"context"
	"fmt"
	"os"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/e2b-dev/infra/packages/shared/pkg/keys"
)

// Usage: POSTGRES_CONNECTION_STRING=... go run gen-api-key.go <team-name> <team-email>
func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: gen-api-key <team-name> <team-email>")
		os.Exit(1)
	}
	teamName := os.Args[1]
	teamEmail := os.Args[2]

	conn, err := pgx.Connect(context.Background(), os.Getenv("POSTGRES_CONNECTION_STRING"))
	if err != nil {
		panic(err)
	}
	defer conn.Close(context.Background())

	teamID := uuid.New()
	_, err = conn.Exec(context.Background(),
		`INSERT INTO teams (id, name, tier, email, slug) VALUES ($1, $2, 'base_v1', $3, $2)`,
		teamID, teamName, teamEmail,
	)
	if err != nil {
		panic(err)
	}

	key, err := keys.GenerateKey(keys.ApiKeyPrefix)
	if err != nil {
		panic(err)
	}

	_, err = conn.Exec(context.Background(),
		`INSERT INTO team_api_keys (team_id, api_key_hash, api_key_prefix, api_key_length, api_key_mask_prefix, api_key_mask_suffix, name)
		 VALUES ($1, $2, $3, $4, $5, $6, 'default')`,
		teamID, key.HashedValue, key.Masked.Prefix, key.Masked.ValueLength, key.Masked.MaskedValuePrefix, key.Masked.MaskedValueSuffix,
	)
	if err != nil {
		panic(err)
	}

	fmt.Printf("team_id=%s\napi_key=%s\n", teamID, key.PrefixedRawValue)
}
