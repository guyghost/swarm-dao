# @guyghost/swarm-dao-software-delivery

Repository-native coordinator for shipping software through Swarm DAO.

The package connects an existing Product Loop run to a hash-approved Graph
Engineering run. It validates producer-bound signals, persists resumable
delivery state, and supports reversible local staging, observation, and
rollback. Local staging does not deploy to production.

## Usage

The `swarm-dao` CLI exposes the workflow:

```sh
bun run software-delivery:stage-init
bun run software-delivery:init --delivery-id release-42 --product-run-id product-42
bun run software-delivery:status --delivery-id release-42
bun run software-delivery:resume --delivery-id release-42
bun run software-delivery:scorecard
```

The first resume validates the Graph model and pauses for human approval of its
exact SHA-256 hash. Review the hash in the delivery status before approving the
Graph run. See the [Software Delivery guide](../../docs/USAGE.md#repository-native-software-delivery)
for setup, approval, observation, and rollback details.

## Library API

The package exports `createDeliveryRunner` for persisted delivery-machine
runs, `advanceDeliveryOnce` for coordinating child runners, and
`runDeliveryCommand` for the CLI command surface. It also exports the local
staging target, observation helpers, and aggregate scorecard APIs.
