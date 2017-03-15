import Approval from './Approval'
import Autobranch from './Autobranch'
import Autolabel from './Autolabel'
import CommitMessage from './CommitMessage'
import Specification from './Specification'
import PullRequestLabels from './PullRequestLabels'
import PullRequestTasks from './PullRequestTasks'
import Review from './Review'

const CHECKS = {
  [Approval.TYPE]: Approval,
  [Autobranch.TYPE]: Autobranch,
  [Autolabel.TYPE]: Autolabel,
  [CommitMessage.TYPE]: CommitMessage,
  [Specification.TYPE]: Specification,
  [PullRequestLabels.TYPE]: PullRequestLabels,
  [PullRequestTasks.TYPE]: PullRequestTasks,
  [Review.TYPE]: Review
}

export const CHECK_NAMES = {
  [Approval.TYPE]: Approval.NAME,
  [Autobranch.TYPE]: Autobranch.NAME,
  [Autolabel.TYPE]: Autolabel.NAME,
  [CommitMessage.TYPE]: CommitMessage.NAME,
  [Specification.TYPE]: Specification.NAME,
  [PullRequestLabels.TYPE]: PullRequestLabels.NAME,
  [PullRequestTasks.TYPE]: PullRequestTasks.NAME,
  [Review.TYPE]: Review.NAME
}

export const CHECK_TYPES = Object.keys(CHECKS)

export function getCheckByType(type) {
  return CHECKS[type]
}

export { Approval, Autobranch, Autolabel, CommitMessage, Specification, PullRequestLabels, PullRequestTasks, Review }
