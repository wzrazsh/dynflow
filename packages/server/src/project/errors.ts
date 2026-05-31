// ---------------------------------------------------------------------------
// Project Service Error Classes
// ---------------------------------------------------------------------------

export class ProjectNotFoundError extends Error {
  constructor(projectName: string) {
    super(`Project not found: ${projectName}`);
    this.name = 'ProjectNotFoundError';
  }
}

export class VersionNotFoundError extends Error {
  constructor(projectName: string, version: number) {
    super(`Version ${version} not found for project: ${projectName}`);
    this.name = 'VersionNotFoundError';
  }
}

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSafetyError';
  }
}

export class ProjectNameValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectNameValidationError';
  }
}

export class VersionReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionReservationError';
  }
}
