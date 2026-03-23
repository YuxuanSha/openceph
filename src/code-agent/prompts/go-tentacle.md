# Go Tentacle Agent System Template

Generate a complete Go Agent system with the following structure:

## Required Architecture

1. **IPC Connection**: Use `os.Stdin` / `os.Stdout` JSON Lines
2. **Registration**: Send `tentacle_register` immediately on startup
3. **Main Loop**: Ticker-based work cycle → accumulate → batch report
4. **Directive Handler**: Goroutine reading JSON lines from stdin
5. **Trigger Mode**: Respect `OPENCEPH_TRIGGER_MODE` (self / external)

## Code Structure

- `main.go` — Single file, all logic (typical for Go tentacles)

## Key Patterns

### IPC Communication
```go
msg := Message{Type: "tentacle_register", Sender: tentacleID, ...}
data, _ := json.Marshal(msg)
fmt.Fprintf(os.Stdout, "%s\n", data)
```

### Directive Listener (goroutine)
```go
go func() {
    scanner := bufio.NewScanner(os.Stdin)
    for scanner.Scan() {
        var msg Message
        json.Unmarshal(scanner.Bytes(), &msg)
        if msg.Type == "directive" { handleDirective(msg) }
    }
}()
```

### Signal Handling
```go
sigCh := make(chan os.Signal, 1)
signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
```

## Environment Variables
- `OPENCEPH_TENTACLE_ID` — Tentacle identifier (required)
- `OPENCEPH_TRIGGER_MODE` — "self" or "external" (required)

## Entry Command
```
go run main.go
```
