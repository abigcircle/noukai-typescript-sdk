export interface NoukaiErrorInit {
  statusCode?: number;
  code?: string;
  executionId?: string;
  requestId?: string;
  responseBody?: unknown;
  cause?: unknown;
}

export class NoukaiError extends Error {
  readonly statusCode?: number | undefined;
  readonly code?: string | undefined;
  readonly executionId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly responseBody?: unknown;

  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, { cause: init.cause });
    this.name = "NoukaiError";
    this.statusCode = init.statusCode;
    this.code = init.code;
    this.executionId = init.executionId;
    this.requestId = init.requestId;
    this.responseBody = init.responseBody;
  }
}

export class APIConnectionError extends NoukaiError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "APIConnectionError";
  }
}

export class APITimeoutError extends APIConnectionError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "APITimeoutError";
  }
}

export class AuthenticationError extends NoukaiError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "AuthenticationError";
  }
}

export class PermissionDeniedError extends NoukaiError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "PermissionDeniedError";
  }
}

export class FlowNotFoundError extends NoukaiError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "FlowNotFoundError";
  }
}

export class InsufficientCreditsError extends NoukaiError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "InsufficientCreditsError";
  }
}

export class RateLimitError extends NoukaiError {
  readonly retryAfter?: number | undefined;
  constructor(
    message: string,
    init: NoukaiErrorInit & { retryAfter?: number } = {},
  ) {
    super(message, init);
    this.name = "RateLimitError";
    this.retryAfter = init.retryAfter;
  }
}

export class FlowExecutionError extends NoukaiError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "FlowExecutionError";
  }
}

export class ToolCallLimitError extends NoukaiError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "ToolCallLimitError";
  }
}

// ---------------------------------------------------------------------------
// Replay errors (see design 20260605-SDK-replay-decorator)
// ---------------------------------------------------------------------------

export class ReplayError extends NoukaiError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "ReplayError";
  }
}

export class ReplayDisabledError extends ReplayError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "ReplayDisabledError";
  }
}

export class ReplayInvalidSessionError extends ReplayError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "ReplayInvalidSessionError";
  }
}

export class ReplayForbiddenError extends ReplayError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "ReplayForbiddenError";
  }
}

export class ReplaySessionNotFoundError extends ReplayError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "ReplaySessionNotFoundError";
  }
}

export class ReplaySessionExpiredError extends ReplayError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "ReplaySessionExpiredError";
  }
}

export class ReplayNoSnapshotsError extends ReplayError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "ReplayNoSnapshotsError";
  }
}

export class ReplayMissError extends ReplayError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "ReplayMissError";
  }
}

export class ReplayLeftoverError extends ReplayError {
  constructor(message: string, init: NoukaiErrorInit = {}) {
    super(message, init);
    this.name = "ReplayLeftoverError";
  }
}
