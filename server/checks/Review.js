import Check from './Check'
import AuditEvent from '../service/audit/AuditEvent'
import { logger, formatDate } from '../../common/debug'
import { promiseReduce, getIn, toGenericComment } from '../../common/util'
import * as EVENTS from '../model/GithubEvents'
import * as AUDIT_EVENTS from '../service/audit/AuditEventTypes'
import * as _ from 'lodash'

const context = 'zappr'
const info = logger('review', 'info')
const debug = logger('review')
const error = logger('review', 'error')

export default class Review extends Check {

  static TYPE = 'review'
  static CONTEXT = context
  static NAME = 'Review check'
  static HOOK_EVENTS = [EVENTS.PULL_REQUEST, EVENTS.PULL_REQUEST_REVIEW]

  /**
   * @param {GithubService} github
   * @param {AuditService} auditService
   */
  constructor(github, auditService) {
    super()
    this.github = github
    this.audit = auditService
  }

  /**
   * Based on the Zappr approval configuration
   * and the approval statistics and number of vetos.
   * Generates a commit status object that it consumed by the Github Status API
   * (https://developer.github.com/v3/repos/statuses/#create-a-status).
   * TODO: change this
   *
   * @param approvals Approval stats. Includes `total` approvals and group information.
   * @param vetos Number of vetos.
   * @param approvalConfig Approval configuration
   * @returns {Object} Object consumable by Github Status API
   */
  static generateStatus(reviews, {minimum, groups}) {
    if (reviews.some(r => r.state == "CHANGES_REQUESTED")) {
      return {
        description: `Vetoes: ${reviews.filter(r => r.state == "CHANGES_REQUESTED").map(r => `@${r.user.login}`).join(', ')}.`,
        state: 'failure',
        context
      }
    }

    if (Object.keys(groups || {}).length > 0) {
      // check group requirements
      const unsatisfied = Object.keys(groups).map(name => {
        return {
          name,
          approvals: groups[name].from.users.reduce((sum, user) => {
            return sum + reviews.some(r => r.state == "APPROVED" && r.user.login == user) ? 1 : 0
          }, 0),
          minimum: groups[name].minimum,
        };
      }).filter(group => group.approvals < group.minimum)

      if (unsatisfied.length > 0) {
        return {
          description: `Missing reviews: ${unsatisfied.map(u => `${u.name} (${u.approvals}/${u.minimum})`).join(', ')}`,
          state: 'pending',
          context
        }
      }
    }

    const approvals = reviews.filter(r => r.state == "APPROVED")
    if (approvals.length < minimum) {
      return {
        description: `This PR needs ${minimum - approvals.length} more approvals (${approvals.length}/${minimum} given).`,
        state: 'pending',
        context
      }
    }

    return {
      description: `Approvals: ${approvals.map(review => `@${review.user.login}`).join(', ')}.`,
      state: 'success',
      context
    }
  }

  /**
   * Fetches PR reviews for pull request and sets status on head commit.
   *
   * @param repository The repository object from GH
   * @param pull_request The pull_request object from GH
   * @param config The Zappr configuration
   * @param token The GH token to use
   */
  async fetchReviewsAndSetStatus(repository, pull_request, config, token) {
    const user = repository.owner.login
    const sha = pull_request.head.sha
    const review_map = (await this.github.getReviews(user, repository.name, pull_request.number, token))
                                     .reduce((o, review) => {
                                       const login = review.user.login;
                                       if ((!o[login] || o[login].id < review.id) && (review.state == "APPROVED" || review.state == "CHANGES_REQUESTED")) {
                                         o[login] = review
                                       }
                                       return o
                                     }, {})
    const reviews = Object.keys(review_map).map(key => review_map[key])
    var groups = config.approvals.groups
    const uses_labels = Object.keys(groups || {}).some(group => groups[group].hasOwnProperty('labels'))
    if (groups && uses_labels) {
      const labels = await this.github.getIssueLabels(user, repository.name, pull_request.number, token)
      Object.keys(groups).forEach(function (key) {
        const group = groups[key]
        if (group.hasOwnProperty('labels') && group.labels.some(l => labels.indexOf(l) === -1)) {
          delete config.approvals.groups[key]
        }
      })
      // Find the groups that are approved and apply approval labels for that group
      const approved_labels = Object.keys(groups).filter(key => {
        const approvals = groups[key].from.users.reduce((sum, user) => {
          return sum + reviews.some(r => r.state == "APPROVED" && r.user.login == user)
        }, 0)
        return approvals >= groups[key].minimum
      }).map(key => groups[key].approval_label || (key + "-approved"))
      var add_labels = approved_labels.filter(l => labels.indexOf(l) < 0)
      if (add_labels.length > 0) {
        await this.github.addIssueLabels(user, repository.name, pull_request.number, add_labels, token)
      }
    }
    const status = Review.generateStatus(reviews, config.approvals)
    // update status
    await this.github.setCommitStatus(user, repository.name, sha, status, token)
    await this.audit.log(new AuditEvent(AUDIT_EVENTS.COMMIT_STATUS_UPDATE).fromGithubEvent({
                                                                            repository,
                                                                            pull_request
                                                                          })
                                                                          .withResult({
                                                                            status
                                                                          })
                                                                          .onResource({
                                                                            commit: sha,
                                                                            issue_number: pull_request.number,
                                                                            repository
                                                                          }))
    // info(`${repository.full_name}#${pull_request.number}: Set state to ${status.state} (${approvals.total.length}/${config.approvals.minimum} - ${vetos} vetos)`)
  }


  /**
   * Executes approval check.
   *
   * - PR open/reopen:
   *   1. set status to pending
   *   2. count approvals since last commit
   *   3. set status to ok when there are enough approvals
   * - IssueComment create/delete:
   *   1. verify it's on an open pull request
   *   2. set status to pending for open PR
   *   3. count approvals since last commit
   *   4. set status to ok when there are enough approvals
   * - PR synchronize (new commits on top):
   *   1. set status back to pending (b/c there can't be comments afterwards already)
   *
   * @param config The Zappr configuration (all of it)
   * @param event The GitHub event, e.g. pull_request
   * @param hookPayload The payload of the call
   * @param token The GitHub token to use
   * @param dbRepoId The database ID of the affected repository
   */
  async execute(config, event, hookPayload, token, dbRepoId) {
    const {action, repository, pull_request} = hookPayload
    const number = pull_request.number
    const repoName = repository.name
    const user = repository.owner.login
    const {minimum} = config.approvals
    let sha = ''
    debug(`${repository.full_name}: Got hook action:${action} for PR ${number}`)

    try {
      // on an open pull request
      if ((event === EVENTS.PULL_REQUEST || event === EVENTS.PULL_REQUEST_REVIEW) && pull_request.state === 'open') {
        sha = pull_request.head.sha
        // if it was (re)opened
        if (action === 'opened' && minimum > 0) {
          // if it was opened, set to pending
          const status = Review.generateStatus([], {minimum})
          await this.github.setCommitStatus(user, repoName, sha, status, token)
          await this.audit.log(new AuditEvent(AUDIT_EVENTS.COMMIT_STATUS_UPDATE).fromGithubEvent(hookPayload)
                                                                                .withResult({
                                                                                  status
                                                                                })
                                                                                .onResource({
                                                                                  commit: sha,
                                                                                  issue_number: number,
                                                                                  repository
                                                                                }))
          info(`${repository.full_name}#${number}: PR was opened, set state to pending`)
        } else if (action === 'reopened' || action == 'submitted' || action == 'synchronize' || action == 'dismissed') {
            await this.fetchReviewsAndSetStatus(repository, pull_request, config, token)
        } else if (action === 'labeled' || action === 'unlabeled') {
          // Check to make sure it's a label we care about, otherwise this should be a noop
          const label = hookPayload.label.name
          var groups = config.approvals.groups || {}
          const uses_label = Object.keys(groups).some(group => (groups[group].labels || []).indexOf(label) !== -1)
          if (!uses_label) {
            return
          }
          await this.fetchReviewsAndSetStatus(repository, pull_request, config, token)
        }
      }
    }
    catch (e) {
      error(e)
      await this.github.setCommitStatus(user, repoName, sha, {
        state: 'error',
        context,
        description: e.message
      }, token)
    }
  }
}
