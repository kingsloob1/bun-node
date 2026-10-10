// Generated from the server's route model. Do not edit.
// hash: aa196cb08f89b79e
export interface Routes {
  "DELETE /users/:id": {
    operationId: "deleteUsersById";
    params: {
      id: string;
    };
    query: Record<never, never>;
    body: undefined;
    responses: {
      204: undefined;
      404: {
        type: string;
        title: string;
        status: number;
        code?: string;
      };
    };
  };
  "GET /legacy": {
    operationId: "getLegacy";
    params: Record<never, never>;
    query: Record<never, never>;
    body: undefined;
    responses: { 200: unknown };
  };
  "GET /orgs/:org/members/:id": {
    operationId: "getOrgsByOrgMembersById";
    params: {
      org: string;
      id: string;
    };
    query: Record<never, never>;
    body: undefined;
    responses: {
      200: {
        org: string;
        id: string;
        since: unknown;
      };
    };
  };
  "GET /users": {
    operationId: "getUsers";
    params: Record<never, never>;
    query: {
      page?: number;
      q?: string;
    };
    body: undefined;
    responses: {
      200: {
        items: ({
          id: string;
          name: string;
          email: string;
          role: "admin" | "member";
          createdAt: string;
        })[];
        next: number | null;
      };
    };
  };
  "GET /users/:id": {
    operationId: "getUsersById";
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
        role: "admin" | "member";
        createdAt: string;
      };
      404: {
        type: string;
        title: string;
        status: number;
        code?: string;
      };
    };
  };
  "POST /users": {
    operationId: "postUsers";
    params: Record<never, never>;
    query: Record<never, never>;
    body: {
      name: string;
      email: string;
      role?: "admin" | "member";
    };
    responses: {
      201: {
        id: string;
        name: string;
        email: string;
        role: "admin" | "member";
        createdAt: string;
      };
      409: {
        type: string;
        title: string;
        status: number;
        code?: string;
      };
    };
  };
}
