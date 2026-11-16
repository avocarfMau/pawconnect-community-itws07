import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MyAdoptionsPage } from './my-adoptions.page';

describe('MyAdoptionsPage', () => {
  let component: MyAdoptionsPage;
  let fixture: ComponentFixture<MyAdoptionsPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(MyAdoptionsPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
