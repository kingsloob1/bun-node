// Generated from the server's route model. Do not edit.
// hash: 1b1503131d867aa0
export interface Routes {
  "GET /api/__bun/types": {
    operationId: "devtypes.model";
    params: Record<never, never>;
    query: Record<never, never>;
    body: undefined;
    responses: { 200: unknown };
  };
  "GET /api/health": {
    operationId: "health.ok";
    params: Record<never, never>;
    query: Record<never, never>;
    body: undefined;
    responses: {
      200: {
        ok: boolean;
      };
    };
  };
  "GET /api/users": {
    operationId: "users.list";
    params: Record<never, never>;
    query: {
      page?: number;
    };
    body: undefined;
    responses: {
      200: {
        id: string;
        name: string;
        email: string;
      }[];
    };
  };
  "GET /api/users/:id": {
    operationId: "users.one";
    params: {
      id: string;
    };
    query: Record<never, never>;
    body: undefined;
    responses: {
      200: {
        id: string;
        name: string;
        email: string;
      };
      404: {
        type: string;
        title: string;
        status: number;
      };
    };
  };
  "GET /api/users/untyped/legacy": {
    operationId: "users.legacy";
    params: Record<never, never>;
    query: Record<never, never>;
    body: undefined;
    responses: { 200: unknown };
  };
  "POST /api/users": {
    operationId: "users.create";
    params: Record<never, never>;
    query: Record<never, never>;
    body: {
      name: string;
      email: string;
    };
    responses: {
      201: {
        id: string;
        name: string;
        email: string;
      };
    };
  };
}
