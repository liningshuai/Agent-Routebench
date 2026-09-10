// Compatibility re-export layer.
//
// The single real implementation of these contracts lives in
// `@agent-workbench/agent-contracts`. This file exists only so that existing
// relative imports keep working; it must never define its own implementation.
export type {
  ModelGateway,
  ModelStreamEvent,
} from "@agent-workbench/agent-contracts";
