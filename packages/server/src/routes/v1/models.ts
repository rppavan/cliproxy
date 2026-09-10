import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { ModelObject, ModelListResponse } from '@star-cliproxy/shared';
import { getDatabase } from '../../db/client.js';
import { modelMappings } from '../../db/schema.js';
import type { ModelCatalog } from '../../services/model-catalog.js';

export interface ModelsRouteDeps {
  modelCatalog?: ModelCatalog;
}

export function registerModelsRoute(app: FastifyInstance, deps?: ModelsRouteDeps): void {
  app.get('/v1/models', async (_request, reply) => {
    if (deps?.modelCatalog) {
      const catalogModels = await deps.modelCatalog.getModels();
      const models: ModelObject[] = catalogModels.map((m) => ({
        id: m.id,
        object: 'model' as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: m.ownedBy,
      }));
      const response: ModelListResponse = {
        object: 'list',
        data: models,
      };
      return reply.send(response);
    }

    const db = getDatabase();

    const mappings = await db
      .select()
      .from(modelMappings)
      .where(eq(modelMappings.enabled, true));

    // Deduplicate by alias across multiple provider fallbacks.
    const uniqueAliases = new Map<string, typeof mappings[0]>();
    for (const m of mappings) {
      if (!uniqueAliases.has(m.alias)) {
        uniqueAliases.set(m.alias, m);
      }
    }

    const models: ModelObject[] = Array.from(uniqueAliases.values()).map((m) => ({
      id: m.alias,
      object: 'model' as const,
      created: Math.floor(new Date(m.createdAt).getTime() / 1000),
      owned_by: `cliproxy-${m.provider}`,
    }));

    const response: ModelListResponse = {
      object: 'list',
      data: models,
    };

    return reply.send(response);
  });

  app.get<{ Params: { id: string } }>('/v1/models/:id', async (request, reply) => {
    const { id } = request.params;

    if (deps?.modelCatalog) {
      const found = await deps.modelCatalog.getModel(id);
      if (!found) {
        return reply.status(404).send({
          error: {
            message: `Model "${id}" not found.`,
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_not_found',
          },
        });
      }
      const model: ModelObject = {
        id: found.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: found.ownedBy,
      };
      return reply.send(model);
    }

    const db = getDatabase();

    const results = await db
      .select()
      .from(modelMappings)
      .where(eq(modelMappings.alias, id))
      .limit(1);

    if (results.length === 0) {
      return reply.status(404).send({
        error: {
          message: `Model "${id}" not found.`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      });
    }

    const m = results[0];
    const model: ModelObject = {
      id: m.alias,
      object: 'model',
      created: Math.floor(new Date(m.createdAt).getTime() / 1000),
      owned_by: `cliproxy-${m.provider}`,
    };

    return reply.send(model);
  });
}
