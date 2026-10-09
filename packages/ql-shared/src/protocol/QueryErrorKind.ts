import { JsonRPCProtocol } from "@wireio/cluster-tool-shared"

/** `error.data.kind` of a failed `query.execute` (identity enum, engine README "Errors"). */
export enum QueryErrorKind {
  PARSE_ERROR = "PARSE_ERROR",
  INVALID_REQUEST = "INVALID_REQUEST",
  METHOD_NOT_FOUND = "METHOD_NOT_FOUND",
  INVALID_PARAMS = "INVALID_PARAMS",
  QUERY_SYNTAX = "QUERY_SYNTAX",
  QUERY_SEMANTICS = "QUERY_SEMANTICS",
  QUERY_LIMIT = "QUERY_LIMIT",
  QUERY_TIMEOUT = "QUERY_TIMEOUT",
  QUERY_BUSY = "QUERY_BUSY",
  SCHEMA_CHANGED = "SCHEMA_CHANGED",
  ROW_DECODE_ERROR = "ROW_DECODE_ERROR",
  VALUE_ERROR = "VALUE_ERROR",
  STATE_UNAVAILABLE = "STATE_UNAVAILABLE",
  QUERY_CANCELLED = "QUERY_CANCELLED",
  INTERNAL_ERROR = "INTERNAL_ERROR"
}

/**
 * JSON-RPC `error.code` per kind (numeric enum; the wire integer is the value).
 * The standard JSON-RPC 2.0 members reference {@link JsonRPCProtocol.ErrorCode};
 * the `-320xx` members are the engine's own server-defined codes.
 */
export enum QueryErrorCode {
  PARSE_ERROR = JsonRPCProtocol.ErrorCode.PARSE_ERROR,
  INVALID_REQUEST = JsonRPCProtocol.ErrorCode.INVALID_REQUEST,
  METHOD_NOT_FOUND = JsonRPCProtocol.ErrorCode.METHOD_NOT_FOUND,
  INVALID_PARAMS = JsonRPCProtocol.ErrorCode.INVALID_PARAMS,
  QUERY_SYNTAX = -32010,
  QUERY_SEMANTICS = -32011,
  QUERY_LIMIT = -32012,
  QUERY_TIMEOUT = -32013,
  QUERY_BUSY = -32014,
  SCHEMA_CHANGED = -32015,
  ROW_DECODE_ERROR = -32016,
  VALUE_ERROR = -32017,
  STATE_UNAVAILABLE = -32018,
  QUERY_CANCELLED = -32019,
  INTERNAL_ERROR = JsonRPCProtocol.ErrorCode.INTERNAL_ERROR
}
