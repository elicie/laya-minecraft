"""Classification calibration and flip metrics; state clusters remain explicit."""
import math
import statistics
from common import predict


def probability_metrics(results, questions, temperatures, threshold=0.6):
    output = {}
    for task in questions:
        for scope in ('all', 'original', 'perturbed'):
            rows = [r for r in results if r['task'] == task and
                    (scope == 'all' or (r.get('variant', 'original') == 'original') == (scope == 'original'))]
            if not rows:
                continue
            bins = [{'count': 0, 'correct': 0, 'confidence_sum': 0.0} for _ in range(10)]
            nll = brier = correct = accepted = accepted_correct = 0
            actions = list(questions[task]['criteria'])
            for row in rows:
                answer = predict(row['logits'], task, questions, temperatures[task]['temperature'])
                p = answer['probabilities']
                hit = answer['choice'] == row['expected']
                correct += hit
                nll -= math.log(max(p[row['expected']], 1e-15))
                brier += sum((p[a] - (a == row['expected']))**2 for a in actions)
                group = bins[min(9, int(answer['confidence']*10))]
                group['count'] += 1; group['correct'] += hit; group['confidence_sum'] += answer['confidence']
                if answer['confidence'] >= threshold:
                    accepted += 1; accepted_correct += hit
            ece = 0.0
            for group in bins:
                if group['count']:
                    group['accuracy'] = group['correct']/group['count']
                    group['mean_confidence'] = group['confidence_sum']/group['count']
                    ece += group['count']/len(rows)*abs(group['accuracy']-group['mean_confidence'])
            output[task+':'+scope] = {'items': len(rows), 'accuracy': correct/len(rows),
                                     'negative_log_likelihood': nll/len(rows), 'multiclass_brier': brier/len(rows),
                                     'ece_10_bins': ece, 'threshold': threshold, 'coverage': accepted/len(rows),
                                     'accepted_accuracy': accepted_correct/accepted if accepted else None, 'bins': bins}
    return output


def robustness_metrics(results):
    original = {row['id']: row for row in results if row.get('variant', 'original') == 'original'}
    output = {}
    for row in results:
        name = row.get('variant', 'original')
        if name == 'original':
            continue
        reference = original[row['original_id']]
        group = output.setdefault(name, {'items': 0, 'correct': 0, 'flips': 0})
        group['items'] += 1
        group['correct'] += row['actual'] == row['expected']
        group['flips'] += row['actual'] != reference['actual']
    for group in output.values():
        group['accuracy'] = group['correct']/group['items']
        group['flip_rate'] = group['flips']/group['items']
    return output
