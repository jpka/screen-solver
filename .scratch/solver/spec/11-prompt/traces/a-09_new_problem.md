# Multiples of 3 or 5

```javascript
function solution(number){
  if (number < 0) return 0;

  let total = 0;
  for (let n = 3; n < number; n++) {
    if (n % 3 === 0 || n % 5 === 0) total += n;
  }
  return total;
}
```

A single sweep from 3 up to but not including `number`, adding each value divisible by 3 or by 5. The `||` is what keeps 15, 30, 45 and the rest of the common multiples from being counted twice — a value satisfying both branches still contributes once, which is the note's "only count it once". The negative guard comes first because the loop would otherwise never run and return 0 anyway, but being explicit documents the rule rather than relying on it falling out.

The strict `<` matters: the worked example lists 3, 5, 6, 9 for `solution(10)` and stops before 10 itself, so 10 would be included by an off-by-one and give 33 instead of 23.

O(n) time, O(1) space. A closed form using the sum of an arithmetic series for the multiples of 3, plus those of 5, minus those of 15, would be O(1) — worth reaching for only if the inputs get large enough to matter.
