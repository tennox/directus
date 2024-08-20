import { Action } from '@directus/constants';
import { useEnv } from '@directus/env';
import { ErrorCode, ForbiddenError, InvalidPayloadError, isDirectusError } from '@directus/errors';
import type { Filter } from '@directus/system-data';
import type { Accountability, Comment, Item, PrimaryKey, Query } from '@directus/types';
import { cloneDeep, isNumber, mergeWith, uniq } from 'lodash-es';
import { useLogger } from '../logger/index.js';
import { fetchRolesTree } from '../permissions/lib/fetch-roles-tree.js';
import { validateAccess } from '../permissions/modules/validate-access/validate-access.js';
import type { AbstractServiceOptions, MutationOptions } from '../types/index.js';
import { isValidUuid } from '../utils/is-valid-uuid.js';
import { transaction } from '../utils/transaction.js';
import { Url } from '../utils/url.js';
import { userName } from '../utils/user-name.js';
import { ActivityService } from './activity.js';
import { ItemsService, type QueryOptions } from './items.js';
import { NotificationsService } from './notifications.js';
import { UsersService } from './users.js';

const env = useEnv();
const logger = useLogger();

type serviceOrigin = 'activity' | 'comments';

// TODO: Remove legacy comments logic
export class CommentsService extends ItemsService {
	activityService: ActivityService;
	notificationsService: NotificationsService;
	usersService: UsersService;
	serviceOrigin: serviceOrigin;

	constructor(
		options: AbstractServiceOptions & { serviceOrigin: serviceOrigin }, // TODO: Remove serviceOrigin when legacy comments are migrated
	) {
		super('directus_comments', options);
		this.activityService = new ActivityService(options);
		this.notificationsService = new NotificationsService({ schema: this.schema });
		this.usersService = new UsersService({ schema: this.schema });
		this.serviceOrigin = options.serviceOrigin ?? 'comments';
	}

	override readOne(key: PrimaryKey, query?: Query, opts?: QueryOptions): Promise<Item> {
		const isLegacyComment = !isNaN(Number(key));

		let result;

		if (isLegacyComment) {
			const activityQuery = this.serviceOrigin === 'activity' ? query : this.generateQuery('activity', query || {});
			result = this.activityService.readOne(key, activityQuery, opts);
		} else {
			const commentsQuery = this.serviceOrigin === 'comments' ? query : this.generateQuery('comments', query || {});
			result = super.readOne(key, commentsQuery, opts);
		}

		return result;
	}

	override async readByQuery(query: Query, opts?: QueryOptions): Promise<Item[]> {
		const activityQuery = this.serviceOrigin === 'activity' ? query : this.generateQuery('activity', query);
		const commentsQuery = this.serviceOrigin === 'comments' ? query : this.generateQuery('comments', query);
		const activityResult = await this.activityService.readByQuery(activityQuery, opts);
		const commentsResult = await super.readByQuery(commentsQuery, opts);

		if (query.aggregate) {
			// Merging the first result only as the app does not utilise group
			return [
				mergeWith({}, activityResult[0], commentsResult[0], (a: any, b: any) => {
					if (isNumber(a) && isNumber(b)) {
						return a + b;
					}

					return;
				}),
			];
		} else if (query.sort) {
			return this.sortLegacyResults([...activityResult, ...commentsResult], query.sort);
		} else {
			return [...activityResult, ...commentsResult];
		}
	}

	override async readMany(keys: PrimaryKey[], query?: Query, opts?: QueryOptions): Promise<Item[]> {
		const commentsKeys = [];
		const activityKeys = [];

		for (const key of keys) {
			if (isNaN(Number(key))) {
				commentsKeys.push(key);
			} else {
				activityKeys.push(key);
			}
		}

		const activityQuery = this.serviceOrigin === 'activity' ? query : this.generateQuery('activity', query || {});
		const commentsQuery = this.serviceOrigin === 'comments' ? query : this.generateQuery('comments', query || {});
		const activityResult = await this.activityService.readMany(activityKeys, activityQuery, opts);
		const commentsResult = await super.readMany(commentsKeys, commentsQuery, opts);

		if (query?.sort) {
			return this.sortLegacyResults([...activityResult, ...commentsResult], query.sort);
		} else {
			return [...activityResult, ...commentsResult];
		}
	}

	override async createOne(
		data: Partial<Comment>,
		opts?: MutationOptions & { skipMentions?: boolean },
	): Promise<PrimaryKey> {
		if (!data['comment']) {
			throw new InvalidPayloadError({ reason: `"comment" is required` });
		}

		if (!data['collection']) {
			throw new InvalidPayloadError({ reason: `"collection" is required` });
		}

		if (!data['item']) {
			throw new InvalidPayloadError({ reason: `"item" is required` });
		}

		if (this.accountability) {
			await validateAccess(
				{
					accountability: this.accountability,
					action: 'read',
					collection: data['collection'],
					primaryKeys: [data['item']],
				},
				{
					schema: this.schema,
					knex: this.knex,
				},
			);
		}

		const usersRegExp = new RegExp(/@[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}/gi);

		const mentions = uniq(data['comment'].match(usersRegExp) ?? []);

		const sender = await this.usersService.readOne(this.accountability!.user!, {
			fields: ['id', 'first_name', 'last_name', 'email'],
		});

		if (!opts?.skipMentions) {
			for (const mention of mentions) {
				const userID = mention.substring(1);

				const user = await this.usersService.readOne(userID, {
					fields: ['id', 'first_name', 'last_name', 'email', 'role.id', 'role.admin_access', 'role.app_access'],
				});

				const accountability: Accountability = {
					user: userID,
					role: user['role']?.id ?? null,
					admin: user['role']?.admin_access ?? null,
					app: user['role']?.app_access ?? null,
					roles: await fetchRolesTree(user['role']?.id, this.knex),
					ip: null,
				};

				const usersService = new UsersService({ schema: this.schema, accountability });

				try {
					await validateAccess(
						{
							accountability,
							action: 'read',
							collection: data['collection'],
							primaryKeys: [data['item']],
						},
						{
							schema: this.schema,
							knex: this.knex,
						},
					);

					const templateData = await usersService.readByQuery({
						fields: ['id', 'first_name', 'last_name', 'email'],
						filter: { id: { _in: mentions.map((mention) => mention.substring(1)) } },
					});

					const userPreviews = templateData.reduce(
						(acc, user) => {
							acc[user['id']] = `<em>${userName(user)}</em>`;
							return acc;
						},
						{} as Record<string, string>,
					);

					let comment = data['comment'];

					for (const mention of mentions) {
						const uuid = mention.substring(1);
						// We only match on UUIDs in the first place. This is just an extra sanity check.
						if (isValidUuid(uuid) === false) continue;
						comment = comment.replace(new RegExp(mention, 'gm'), userPreviews[uuid] ?? '@Unknown User');
					}

					comment = `> ${comment.replace(/\n+/gm, '\n> ')}`;

					const href = new Url(env['PUBLIC_URL'] as string)
						.addPath('admin', 'content', data['collection'], data['item'])
						.toString();

					const message = `
Hello ${userName(user)},

${userName(sender)} has mentioned you in a comment:

${comment}

<a href="${href}">Click here to view.</a>
`;

					await this.notificationsService.createOne({
						recipient: userID,
						sender: sender['id'],
						subject: `You were mentioned in ${data['collection']}`,
						message,
						collection: data['collection'],
						item: data['item'],
					});
				} catch (err: any) {
					if (isDirectusError(err, ErrorCode.Forbidden)) {
						logger.warn(`User ${userID} doesn't have proper permissions to receive notification for this item.`);
					} else {
						throw err;
					}
				}
			}
		}

		return super.createOne(data, opts);
	}

	async migrateComment(activityPk: PrimaryKey): Promise<PrimaryKey> {
		return transaction(this.knex, async (trx) => {
			const sudoCommentsService = new CommentsService({
				schema: this.schema,
				knex: trx,
				serviceOrigin: this.serviceOrigin,
			});

			const sudoActivityService = new ActivityService({
				schema: this.schema,
				knex: trx,
			});

			const legacyComment = await sudoActivityService.readOne(activityPk);
			let primaryKey;

			// Legacy comment
			if (legacyComment['action'] === Action.COMMENT) {
				primaryKey = await sudoCommentsService.createOne(
					{
						collection: legacyComment['collection'],
						item: legacyComment['item'],
						comment: legacyComment['comment'],
						user_created: legacyComment['user'],
						date_created: legacyComment['timestamp'],
					},
					{
						bypassLimits: true,
						emitEvents: false,
						skipMentions: true,
					},
				);

				await sudoActivityService.updateOne(
					activityPk,
					{
						collection: 'directus_comments',
						action: Action.CREATE,
						item: primaryKey,
					},
					{
						bypassLimits: true,
						emitEvents: false,
					},
				);
			}
			// Migrated comment
			else if (legacyComment['collection'] === 'directus_comment' && legacyComment['action'] === Action.CREATE) {
				const newComment = await sudoCommentsService.readOne(legacyComment['item'], { fields: ['id'] });
				primaryKey = newComment['id'];
			}

			if (!primaryKey) {
				throw new ForbiddenError();
			}

			return primaryKey;
		});
	}

	generateQuery(type: 'activity' | 'comments', originalQuery: Query): Query {
		const query: Query = cloneDeep(originalQuery);
		const defaultActivityCommentFilter = { action: { _eq: Action.COMMENT } };

		const commentsToActivityFieldMap: Record<string, string> = {
			id: 'id',
			comment: 'comment',
			item: 'item',
			collection: 'collection',
			user_created: 'user',
			date_created: 'timestamp',
		};

		const activityToCommentsFieldMap: Record<string, string> = {
			id: 'id',
			comment: 'comment',
			item: 'item',
			collection: 'collection',
			user: 'user_created',
			timestamp: 'date_created',
		};

		const targetFieldMap = type === 'activity' ? commentsToActivityFieldMap : activityToCommentsFieldMap;

		for (const key of Object.keys(originalQuery)) {
			switch (key as keyof Filter) {
				case 'fields':
					if (!originalQuery.fields) break;

					query.fields = [];

					for (const field of originalQuery.fields) {
						if (field === '*') {
							query.fields = ['*'];
							break;
						}

						const parts = field.split('.');
						const firstPart = parts[0];

						if (firstPart && targetFieldMap[firstPart]) {
							query.fields.push(field);

							if (firstPart !== targetFieldMap[firstPart]) {
								(query.alias = query.alias || {})[firstPart] = targetFieldMap[firstPart]!;
							}
						}
					}

					break;
				case 'filter':
					if (!originalQuery.filter) break;

					if (type === 'activity') {
						query.filter = { _and: [defaultActivityCommentFilter, originalQuery.filter] };
					}

					if (type === 'comments' && this.serviceOrigin === 'activity') {
						if ('_and' in originalQuery.filter && Array.isArray(originalQuery.filter['_and'])) {
							query.filter = {
								_and: originalQuery.filter['_and'].filter(
									(andItem) =>
										!('action' in andItem && '_eq' in andItem['action'] && andItem['action']['_eq'] === 'comment'),
								),
							};
						} else {
							query.filter = originalQuery.filter;
						}
					}

					break;
				case 'aggregate':
					if (originalQuery.aggregate) {
						query.aggregate = originalQuery.aggregate;
					}

					break;
				case 'sort':
					if (!originalQuery.sort) break;

					query.sort = [];

					for (const sort of originalQuery.sort) {
						const isDescending = sort.startsWith('-');
						const field = isDescending ? sort.slice(1) : sort;

						if (field && targetFieldMap[field]) {
							query.sort.push(`${isDescending ? '-' : ''}${targetFieldMap[field]}`);
						}
					}

					break;
			}
		}

		if (type === 'activity' && !query.filter) {
			query.filter = defaultActivityCommentFilter;
		}

		return query;
	}

	private sortLegacyResults(results: Item[], sortKeys: string[]) {
		return results.sort((a, b) => {
			for (const key of sortKeys) {
				const isDescending = key.startsWith('-');
				const actualKey = isDescending ? key.substring(1) : key;

				let aValue = a[actualKey];
				let bValue = b[actualKey];

				if (actualKey === 'date_created') {
					aValue = new Date(aValue);
					bValue = new Date(bValue);
				}

				if (aValue < bValue) return isDescending ? 1 : -1;
				if (aValue > bValue) return isDescending ? -1 : 1;
			}

			return 0;
		});
	}
}
