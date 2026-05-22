package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/e2b-dev/infra/packages/shared/pkg/featureflags"
)

type resumeBenchOptions struct {
	enabled    bool
	iterations int
	warmup     int
}

type resumeBenchArm struct {
	name         string
	useMemfd     bool
	useMemfdWake bool
}

var resumeBenchArms = []resumeBenchArm{
	{name: "default", useMemfd: false, useMemfdWake: false},
	{name: "memfd-copy", useMemfd: true, useMemfdWake: false},
	{name: "memfd-wake", useMemfd: true, useMemfdWake: true},
}

func (r *runner) resumeBench(ctx context.Context, opts resumeBenchOptions) error {
	if opts.iterations <= 0 {
		return errors.New("resume-bench: iterations must be > 0")
	}
	fmt.Printf("Resume bench (%d iterations per arm, warmup=%d)\n", opts.iterations, opts.warmup)

	results := make(map[string][]time.Duration, len(resumeBenchArms))
	for _, arm := range resumeBenchArms {
		featureflags.OverrideBoolFlag(featureflags.UseMemFdFlag, arm.useMemfd)
		featureflags.OverrideBoolFlag(featureflags.UseMemfdWakeFlag, arm.useMemfdWake)

		for i := range opts.warmup {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if _, err := r.resumeOnce(ctx, i); err != nil {
				return fmt.Errorf("%s warmup: %w", arm.name, err)
			}
		}

		samples := make([]time.Duration, 0, opts.iterations)
		for i := range opts.iterations {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			dur, err := r.resumeOnce(ctx, i)
			if err != nil {
				return fmt.Errorf("%s iter %d: %w", arm.name, i+1, err)
			}
			samples = append(samples, dur)
			fmt.Printf("[%d/%d] %-10s: %s\n", i+1, opts.iterations, arm.name, dur.Round(time.Millisecond))
		}
		results[arm.name] = samples
	}

	fmt.Println()
	for _, arm := range resumeBenchArms {
		s := results[arm.name]
		fmt.Printf("%-10s  avg %s  min %s  max %s\n",
			arm.name,
			avgDuration(s).Round(time.Millisecond),
			minDuration(s).Round(time.Millisecond),
			maxDuration(s).Round(time.Millisecond),
		)
	}

	return nil
}

func avgDuration(s []time.Duration) time.Duration {
	if len(s) == 0 {
		return 0
	}
	var sum time.Duration
	for _, d := range s {
		sum += d
	}

	return sum / time.Duration(len(s))
}

func minDuration(s []time.Duration) time.Duration {
	if len(s) == 0 {
		return 0
	}
	m := s[0]
	for _, d := range s[1:] {
		if d < m {
			m = d
		}
	}

	return m
}

func maxDuration(s []time.Duration) time.Duration {
	if len(s) == 0 {
		return 0
	}
	m := s[0]
	for _, d := range s[1:] {
		if d > m {
			m = d
		}
	}

	return m
}
