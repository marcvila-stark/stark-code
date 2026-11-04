import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as CodexRpc from "./_generated/meta.gen.ts";
import * as CodexSchema from "./_generated/schema.gen.ts";
import * as CodexSchemaV0163 from "./schema.ts";
import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import {
  decodeNotificationPayload,
  decodeOptionalPayload,
  encodeOptionalPayload,
  runHandler,
} from "./_internal/shared.ts";
import { makeChildStdio, makeTerminationError } from "./_internal/stdio.ts";

export interface CodexAppServerClientOptions {
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (
    event: CodexProtocol.CodexAppServerProtocolLogEvent,
  ) => Effect.Effect<void, never>;
}

interface CodexAppServerClientRaw {
  readonly notifications: CodexProtocol.CodexAppServerPatchedProtocol["incomingNotifications"];
  readonly requests: CodexProtocol.CodexAppServerPatchedProtocol["incomingRequests"];
  readonly request: CodexProtocol.CodexAppServerPatchedProtocol["request"];
  readonly notify: CodexProtocol.CodexAppServerPatchedProtocol["notify"];
  readonly respond: CodexProtocol.CodexAppServerPatchedProtocol["respond"];
  readonly respondError: CodexProtocol.CodexAppServerPatchedProtocol["respondError"];
}

/**
 * Params Codex 0.163.0 sends with a server request, where Stark decodes more
 * than the checked-in schema (see `schema.ts`).
 */
export type ServerRequestParams<M extends CodexRpc.ServerRequestMethod> =
  M extends "item/commandExecution/requestApproval"
    ? CodexSchemaV0163.CommandExecutionRequestApprovalParamsV0163
    : CodexRpc.ServerRequestParamsByMethod[M];

/** A client request's response, with the 0.163.0 fields Stark decodes (see `schema.ts`). */
export type ClientRequestResponse<M extends CodexRpc.ClientRequestMethod> = M extends "thread/start"
  ? CodexSchemaV0163.ThreadStartResponseV0163
  : M extends "thread/fork"
    ? CodexSchemaV0163.ThreadForkResponseV0163
    : CodexRpc.ClientRequestResponsesByMethod[M];

/**
 * What a server-request handler knows besides the params: the JSON-RPC id
 * Codex gave the request, which `serverRequest/resolved` names when Codex
 * stops waiting for an answer on its own.
 */
export interface ServerRequestContext {
  readonly requestId: string | number;
  /**
   * Succeeds once the handler's result was encoded and accepted by the live
   * transport for writing to Codex; fails when it was not sent (the transport
   * had ended, the result did not encode, or the handler failed or was
   * interrupted). Awaited only after the handler has returned its result, it
   * tells whoever chose that result whether it left Stark.
   */
  readonly responseSent: Effect.Effect<void, CodexError.CodexAppServerError>;
}

export class CodexAppServerClient extends Context.Service<
  CodexAppServerClient,
  {
    readonly raw: CodexAppServerClientRaw;
    readonly request: <M extends CodexRpc.ClientRequestMethod>(
      method: M,
      payload: CodexRpc.ClientRequestParamsByMethod[M],
    ) => Effect.Effect<ClientRequestResponse<M>, CodexError.CodexAppServerError>;
    readonly notify: <M extends CodexRpc.ClientNotificationMethod>(
      method: M,
      payload: CodexRpc.ClientNotificationParamsByMethod[M],
    ) => Effect.Effect<void, CodexError.CodexAppServerError>;
    readonly handleServerRequest: <M extends CodexRpc.ServerRequestMethod>(
      method: M,
      handler: (
        payload: ServerRequestParams<M>,
        context: ServerRequestContext,
      ) => Effect.Effect<
        CodexRpc.ServerRequestResponsesByMethod[M],
        CodexError.CodexAppServerError
      >,
    ) => Effect.Effect<void>;
    readonly handleServerNotification: <M extends CodexRpc.ServerNotificationMethod>(
      method: M,
      handler: (
        payload: CodexRpc.ServerNotificationParamsByMethod[M],
      ) => Effect.Effect<void, CodexError.CodexAppServerError>,
    ) => Effect.Effect<void>;
    readonly handleUnknownServerRequest: (
      handler: (
        method: string,
        params: unknown,
      ) => Effect.Effect<unknown, CodexError.CodexAppServerError>,
    ) => Effect.Effect<void>;
    readonly handleUnknownServerNotification: (
      handler: (
        method: string,
        params: unknown,
      ) => Effect.Effect<void, CodexError.CodexAppServerError>,
    ) => Effect.Effect<void>;
  }
>()("effect-codex-app-server/client/CodexAppServerClient") {}

type ServerRequestHandler = (
  payload: unknown,
  context: ServerRequestContext,
) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
type ServerNotificationHandler = (
  payload: unknown,
) => Effect.Effect<void, CodexError.CodexAppServerError>;

const V2TurnStartParamsWithCollaborationMode = CodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(CodexSchema.ClientRequest__CollaborationMode),
    additionalContext: Schema.optionalKey(
      Schema.Record(Schema.String, CodexSchema.V2TurnStartParams__AdditionalContextEntry),
    ),
  }),
);

export const make = Effect.fn("effect-codex-app-server/CodexAppServerClient.make")(function* (
  stdio: Stdio.Stdio,
  options: CodexAppServerClientOptions = {},
  terminationError?: Effect.Effect<CodexError.CodexAppServerError>,
): Effect.fn.Return<CodexAppServerClient["Service"], never, Scope.Scope> {
  const requestHandlers = new Map<string, ServerRequestHandler>();
  // Per in-flight server request: completed when its result was sent or not.
  const responseOutcomes = new Map<
    string,
    Deferred.Deferred<void, CodexError.CodexAppServerError>
  >();
  const notificationHandlers = new Map<string, Array<ServerNotificationHandler>>();
  let unknownRequestHandler:
    | ((method: string, params: unknown) => Effect.Effect<unknown, CodexError.CodexAppServerError>)
    | undefined;
  let unknownNotificationHandler:
    | ((method: string, params: unknown) => Effect.Effect<void, CodexError.CodexAppServerError>)
    | undefined;

  const getServerRequestParamSchema = <M extends CodexRpc.ServerRequestMethod>(
    method: M,
  ): Schema.Codec<ServerRequestParams<M>, ServerRequestParams<M>> | undefined =>
    method === "item/commandExecution/requestApproval"
      ? (CodexSchemaV0163.CommandExecutionRequestApprovalParamsV0163 as never)
      : (CodexRpc.SERVER_REQUEST_PARAMS[method] as never);

  const getServerRequestResponseSchema = <M extends CodexRpc.ServerRequestMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ServerRequestResponsesByMethod[M],
        CodexRpc.ServerRequestResponsesByMethod[M]
      >
    | undefined => CodexRpc.SERVER_REQUEST_RESPONSES[method] as never;

  const getClientRequestParamSchema = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
  ):
    | Schema.Codec<CodexRpc.ClientRequestParamsByMethod[M], CodexRpc.ClientRequestParamsByMethod[M]>
    | undefined =>
    method === "turn/start"
      ? (V2TurnStartParamsWithCollaborationMode as never)
      : (CodexRpc.CLIENT_REQUEST_PARAMS[method] as never);

  const getClientRequestResponseSchema = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
  ): Schema.Codec<ClientRequestResponse<M>, ClientRequestResponse<M>> | undefined =>
    method === "thread/start"
      ? (CodexSchemaV0163.ThreadStartResponseV0163 as never)
      : method === "thread/fork"
        ? (CodexSchemaV0163.ThreadForkResponseV0163 as never)
        : (CodexRpc.CLIENT_REQUEST_RESPONSES[method] as never);

  const getClientNotificationParamSchema = <M extends CodexRpc.ClientNotificationMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ClientNotificationParamsByMethod[M],
        CodexRpc.ClientNotificationParamsByMethod[M]
      >
    | undefined => CodexRpc.CLIENT_NOTIFICATION_PARAMS[method] as never;

  const dispatchNotification = (
    notification: CodexProtocol.CodexAppServerIncomingNotification,
  ): Effect.Effect<void, never> => {
    const schema =
      notification.method in CodexRpc.SERVER_NOTIFICATION_PARAMS
        ? CodexRpc.SERVER_NOTIFICATION_PARAMS[
            notification.method as CodexRpc.ServerNotificationMethod
          ]
        : undefined;
    const handlers = notificationHandlers.get(notification.method) ?? [];

    if (schema) {
      return decodeNotificationPayload(notification.method, schema, notification.params).pipe(
        Effect.flatMap((decoded) =>
          Effect.forEach(handlers, (handler) => handler(decoded), { discard: true }),
        ),
        Effect.ignore,
      );
    }

    return unknownNotificationHandler
      ? unknownNotificationHandler(notification.method, notification.params).pipe(Effect.ignore)
      : Effect.void;
  };

  const dispatchRequest = (
    request: CodexProtocol.CodexAppServerIncomingRequest,
  ): Effect.Effect<unknown, CodexError.CodexAppServerError> => {
    if (request.method in CodexRpc.SERVER_REQUEST_PARAMS) {
      const method = request.method as CodexRpc.ServerRequestMethod;
      const payloadSchema = getServerRequestParamSchema(method);
      const responseSchema = getServerRequestResponseSchema(method);
      const handler = requestHandlers.get(method);

      const sent = Deferred.makeUnsafe<void, CodexError.CodexAppServerError>();
      responseOutcomes.set(String(request.id), sent);
      return decodeOptionalPayload(method, payloadSchema, request.params).pipe(
        Effect.flatMap((decoded) =>
          runHandler(
            handler === undefined
              ? undefined
              : (payload: unknown) =>
                  handler(payload, { requestId: request.id, responseSent: Deferred.await(sent) }),
            decoded,
            method,
          ),
        ),
        Effect.flatMap((result) => encodeOptionalPayload(method, responseSchema, result)),
      );
    }

    return unknownRequestHandler
      ? unknownRequestHandler(request.method, request.params)
      : Effect.fail(CodexError.CodexAppServerRequestError.methodNotFound(request.method));
  };

  const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
    stdio,
    ...(terminationError ? { terminationError } : {}),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    onNotification: dispatchNotification,
    onRequest: dispatchRequest,
    onResponseOutcome: (requestId, outcome) =>
      Effect.suspend(() => {
        const sent = responseOutcomes.get(String(requestId));
        if (sent === undefined) return Effect.void;
        responseOutcomes.delete(String(requestId));
        return Exit.isSuccess(outcome)
          ? Deferred.succeed(sent, undefined)
          : Deferred.fail(
              sent,
              Option.getOrElse(
                Cause.findErrorOption(outcome.cause),
                () =>
                  new CodexError.CodexAppServerTransportError({
                    operation: "write-response",
                    cause: outcome.cause,
                  }),
              ),
            );
      }).pipe(Effect.asVoid),
  });

  const request = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ): Effect.Effect<ClientRequestResponse<M>, CodexError.CodexAppServerError> =>
    encodeOptionalPayload(method, getClientRequestParamSchema(method), payload).pipe(
      Effect.flatMap((encoded) => transport.request(method, encoded)),
      Effect.flatMap(
        (raw): Effect.Effect<ClientRequestResponse<M>, CodexError.CodexAppServerError> =>
          decodeOptionalPayload(method, getClientRequestResponseSchema(method), raw),
      ),
    );

  const notify = <M extends CodexRpc.ClientNotificationMethod>(
    method: M,
    payload: CodexRpc.ClientNotificationParamsByMethod[M],
  ) =>
    encodeOptionalPayload(method, getClientNotificationParamSchema(method), payload).pipe(
      Effect.flatMap((encoded) => transport.notify(method, encoded)),
    );

  return CodexAppServerClient.of({
    raw: {
      notifications: transport.incomingNotifications,
      requests: transport.incomingRequests,
      request: transport.request,
      notify: transport.notify,
      respond: transport.respond,
      respondError: transport.respondError,
    },
    request,
    notify,
    handleServerRequest: (method, handler) =>
      Effect.sync(() => {
        requestHandlers.set(method, handler as ServerRequestHandler);
      }),
    handleServerNotification: (method, handler) =>
      Effect.sync(() => {
        const current = notificationHandlers.get(method) ?? [];
        current.push(handler as ServerNotificationHandler);
        notificationHandlers.set(method, current);
      }),
    handleUnknownServerRequest: (handler) =>
      Effect.sync(() => {
        unknownRequestHandler = handler;
      }),
    handleUnknownServerNotification: (handler) =>
      Effect.sync(() => {
        unknownNotificationHandler = handler;
      }),
  });
});

export const layerChildProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: CodexAppServerClientOptions = {},
): Layer.Layer<CodexAppServerClient> =>
  Layer.effect(CodexAppServerClient, makeChildProcessClient(handle, options));

const makeChildProcessClient = Effect.fn(
  "effect-codex-app-server/CodexAppServerClient.makeChildProcessClient",
)(function* (handle: ChildProcessSpawner.ChildProcessHandle, options: CodexAppServerClientOptions) {
  yield* Stream.runDrain(handle.stderr).pipe(Effect.ignore, Effect.forkScoped);
  return yield* make(makeChildStdio(handle), options, makeTerminationError(handle));
});
